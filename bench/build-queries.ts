import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BENCH_DIR } from "./lib/paths.js";

interface Variant {
  kind: string;
  query: string;
  answerTerms: string[];
}

interface Positive {
  id: string;
  agent: string;
  sid: string;
  project: string;
  updated: string | null;
  query: string;
  answerSummary: string;
  answerTerms: string[];
  variants: Variant[];
}

interface PositiveDoc {
  schemaVersion: number;
  corpusCutoff: string;
  count: number;
  byAgent: Record<string, number>;
  records: Positive[];
}

interface Negative {
  id: string;
  query: string;
  sourceSid: string;
  sourceProject: string;
  project: string;
}

interface NegativeDoc {
  schemaVersion: number;
  count: number;
  records: Negative[];
}

interface QueryCase {
  id: string;
  family: "positive" | "known" | "negative";
  kind: string;
  query: string;
  sid: string | null;
  agent: string | null;
  project: string;
  answerTerms: string[];
}

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(BENCH_DIR, name), "utf8")) as T;
}

function writeJson(name: string, value: unknown): string {
  const path = join(BENCH_DIR, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function holderKey(terms: string[]): string {
  return createHash("sha256").update([...new Set(terms)].sort().join("\u0000")).digest("hex");
}

function main(): void {
  const positives = readJson<PositiveDoc>("positives.json");
  const known = readJson<PositiveDoc>("known.json");
  const negatives = readJson<NegativeDoc>("negatives.json");
  const cases: QueryCase[] = [];
  const holders: Record<string, { terms: string[]; holders: string[] }> = {};

  for (const [family, doc] of [
    ["positive", positives],
    ["known", known],
  ] as const) {
    for (const record of doc.records) {
      const originalsAndVariants = [
        { kind: "original", query: record.query, answerTerms: record.answerTerms },
        ...record.variants,
      ];
      for (const item of originalsAndVariants) {
        cases.push({
          id: `${record.id}:${item.kind}`,
          family,
          kind: item.kind,
          query: item.query,
          sid: record.sid,
          agent: record.agent,
          project: record.project,
          answerTerms: item.answerTerms,
        });
        const key = holderKey(item.answerTerms);
        const prior = holders[key];
        if (prior && prior.holders[0] !== record.sid) {
          throw new Error(`holder collision between ${record.id} and ${prior.holders[0]}`);
        }
        holders[key] = { terms: [...new Set(item.answerTerms)], holders: [record.sid] };
      }
    }
  }

  for (const record of negatives.records) {
    cases.push({
      id: `${record.id}:cross-paired`,
      family: "negative",
      kind: "cross_paired",
      query: `在 ${record.project} 项目里查：${record.query}`,
      sid: null,
      agent: null,
      project: record.project,
      answerTerms: [],
    });
  }

  const queries = new Map<string, string>();
  for (const [index, item] of cases.entries()) {
    const key = item.query.trim().replace(/\s+/g, " ");
    const prior = queries.get(key);
    if (prior) {
      throw new Error(`duplicate query: ${item.id} and ${prior}`);
    }
    queries.set(key, item.id);
    if (item.family !== "negative" && (!item.sid || item.answerTerms.length === 0)) {
      throw new Error(`positive query has no answer: ${item.id}`);
    }
    if (item.family === "negative" && item.sid !== null) {
      throw new Error(`negative query has an answer sid: ${item.id}`);
    }
    if (item.query.length > 1_200) {
      throw new Error(`query too long at ${index}: ${item.id}`);
    }
  }

  const queryDoc = {
    schemaVersion: 1,
    corpusCutoff: positives.corpusCutoff,
    count: cases.length,
    byFamily: {
      positive: positives.count * 6,
      known: known.count * 6,
      negative: negatives.count,
    },
    queries: cases,
  };
  const holderDoc = {
    schemaVersion: 1,
    corpusCutoff: positives.corpusCutoff,
    entries: holders,
  };
  writeJson("queries.json", queryDoc);
  writeJson("holder-snapshot.json", holderDoc);

  const manifestPath = join(BENCH_DIR, "manifest.json");
  const manifest = readJson<Record<string, unknown>>("manifest.json");
  const allHashes: Record<string, string> = {};
  for (const file of [
    "positives.json",
    "known.json",
    "negatives.json",
    "queries.json",
    "holder-snapshot.json",
  ]) {
    allHashes[file] = createHash("sha256")
      .update(readFileSync(join(BENCH_DIR, file)))
      .digest("hex");
  }
  const nextManifest = {
    ...manifest,
    generatedAt: new Date().toISOString(),
    counts: {
      ...(manifest.counts as Record<string, number>),
      queryCases: cases.length,
      holderEntries: Object.keys(holders).length,
    },
    sha256: allHashes,
  };
  writeFileSync(manifestPath, `${JSON.stringify(nextManifest, null, 2)}\n`);
  console.log(JSON.stringify({ ...nextManifest.counts, holderEntries: Object.keys(holders).length }, null, 2));
}

main();
