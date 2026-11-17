import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { tokenize } from "../src/tokenize.js";
import { getSession, holderSids } from "./lib/corpus-query.js";
import { BENCH_DIR, TMP_DIR } from "./lib/paths.js";

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
  targetSessionCount?: number;
  overlapHighWatermark?: number;
  sourceInTarget?: boolean;
  crossPairVerified?: boolean;
}

interface NegativeDoc {
  schemaVersion: number;
  count: number;
  records: Negative[];
}

interface HolderSnapshot {
  schemaVersion: number;
  corpusCutoff: string;
  entries: Record<string, { terms: string[]; holders: string[] }>;
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

interface QueryDoc {
  schemaVersion: number;
  corpusCutoff: string;
  count: number;
  byFamily: Record<string, number>;
  queries: QueryCase[];
}

const REQUESTED_VARIANTS = ["paraphrase", "typo", "quoted", "code_path", "occasion"] as const;
const FORBIDDEN_KEYS = new Set(["path", "messages", "text", "fullText", "transcript", "raw"]);
const SECRET_PATTERN =
  /\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[pousr]_[A-Za-z0-9_]{20,}\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

function readJson<T>(name: string): T {
  return JSON.parse(readFileSync(join(BENCH_DIR, name), "utf8")) as T;
}

function fail(errors: string[], message: string): void {
  errors.push(message);
}

function allObjects(value: unknown, keyPath = ""): Array<[string, Record<string, unknown>]> {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => allObjects(item, `${keyPath}[${index}]`));
  }
  const object = value as Record<string, unknown>;
  return [
    [keyPath, object],
    ...Object.entries(object).flatMap(([key, child]) => allObjects(child, keyPath ? `${keyPath}.${key}` : key)),
  ];
}

function assertNoTranscriptPayload(errors: string[], doc: unknown): void {
  for (const [path, object] of allObjects(doc)) {
    for (const key of Object.keys(object)) {
      if (FORBIDDEN_KEYS.has(key)) {
        fail(errors, `forbidden transcript field ${key} at ${path}`);
      }
    }
  }
  if (SECRET_PATTERN.test(JSON.stringify(doc))) {
    fail(errors, "possible credential pattern found in bench data");
  }
}

function uniqueTerms(terms: string[]): string[] {
  return [...new Set(terms.map((term) => term.toLowerCase()))];
}

function holderKey(terms: string[]): string {
  return createHash("sha256").update([...new Set(terms)].sort().join("\u0000")).digest("hex");
}

function assertUniqueHolders(
  errors: string[],
  label: string,
  expectedSid: string,
  terms: string[],
  snapshot: HolderSnapshot | null,
  db: Database.Database | null,
): void {
  const normalized = uniqueTerms(terms);
  if (normalized.length === 0) {
    fail(errors, `${label}: empty answer terms`);
    return;
  }
  const snapshotEntry = snapshot?.entries[holderKey(normalized)];
  if (!snapshotEntry) {
    fail(errors, `${label}: missing holder snapshot entry`);
    return;
  }
  const snapshotHolders = snapshotEntry.holders;
  const holders = db ? holderSids(db, normalized) : snapshotHolders;
  if (holders.length !== 1 || holders[0] !== expectedSid) {
    fail(
      errors,
      `${label}: expected holder ${expectedSid}, got ${holders.length} (${holders.slice(0, 6).join(", ")})`,
    );
  }
  if (db) {
    const expected = getSession(db, expectedSid);
    if (!expected) {
      fail(errors, `${label}: missing expected session ${expectedSid}`);
    }
  }
}

function checkQueries(
  errors: string[],
  db: Database.Database | null,
  snapshot: HolderSnapshot,
  records: Positive[],
  label: string,
): { cases: number; uniqueHolderCases: number } {
  const seenQueries = new Map<string, string>();
  let cases = 0;
  let uniqueHolderCases = 0;

  for (const record of records) {
    if (!record.id || !record.sid || !record.query || !record.answerSummary) {
      fail(errors, `${label}:${record.id ?? "?"} missing required field`);
    }
    if (record.answerSummary.length > 300) {
      fail(errors, `${label}:${record.id} answerSummary too long`);
    }

    const queries = [
      { kind: "original", query: record.query, answerTerms: record.answerTerms },
      ...record.variants,
    ];
    if (record.variants.length !== 5) {
      fail(errors, `${label}:${record.id} expected 5 derived variants, got ${record.variants.length}`);
    }
    const variantKinds = record.variants.map((variant) => variant.kind).sort();
    if (JSON.stringify(variantKinds) !== JSON.stringify([...REQUESTED_VARIANTS].sort())) {
      fail(errors, `${label}:${record.id} variant kinds mismatch: ${variantKinds.join(",")}`);
    }

    for (const item of queries) {
      cases += 1;
      const normalizedQuery = item.query.trim().replace(/\s+/g, " ");
      if (!normalizedQuery) {
        fail(errors, `${label}:${record.id}:${item.kind} empty query`);
        continue;
      }
      const prior = seenQueries.get(normalizedQuery);
      if (prior) {
        fail(errors, `${label}:${record.id}:${item.kind} duplicates ${prior}`);
      }
      seenQueries.set(normalizedQuery, `${record.id}:${item.kind}`);

      if (label === "positive" && item.kind === "original" && db) {
        const queryHolders = holderSids(db, tokenize(item.query));
        if (queryHolders.length !== 1 || queryHolders[0] !== record.sid) {
          fail(
            errors,
            `${label}:${record.id}:original query holders=${queryHolders.length}, expected ${record.sid}`,
          );
        }
      }

      assertUniqueHolders(
        errors,
        `${label}:${record.id}:${item.kind}`,
        record.sid,
        item.answerTerms,
        snapshot,
        db,
      );
      uniqueHolderCases += 1;
    }
  }
  return { cases, uniqueHolderCases };
}

function checkNegatives(
  errors: string[],
  db: Database.Database | null,
  doc: NegativeDoc,
): void {
  if (doc.count !== 15 || doc.records.length !== 15) {
    fail(errors, `negatives: expected 15 records, got ${doc.records.length}`);
  }
  for (const record of doc.records) {
    if (!record.query || !record.sourceSid || !record.project) {
      fail(errors, `${record.id}: missing required field`);
      continue;
    }
    if (record.sourceProject === record.project) {
      fail(errors, `${record.id}: target project equals source project`);
    }
    if (typeof record.targetSessionCount === "number" && record.targetSessionCount <= 0) {
      fail(errors, `${record.id}: target project has no sessions`);
    }
    if (record.sourceInTarget) {
      fail(errors, `${record.id}: answer session exists in target project`);
    }
    if (typeof record.overlapHighWatermark === "number" && record.overlapHighWatermark < 2) {
      fail(errors, `${record.id}: target project has no meaningful lexical overlap`);
    }

    if (!db) {
      if (record.crossPairVerified !== true) {
        fail(errors, `${record.id}: missing persisted cross-pair verification`);
      }
      continue;
    }
    const source = getSession(db, record.sourceSid);
    if (!source) {
      fail(errors, `${record.id}: missing source session ${record.sourceSid}`);
      continue;
    }
    const target = db
      .prepare("SELECT count(*) AS n FROM sessions WHERE project = ?")
      .get(record.project) as { n: number };
    if (target.n === 0) {
      fail(errors, `${record.id}: target project has no sessions`);
    }
    const sourceInTarget = db
      .prepare("SELECT count(*) AS n FROM sessions WHERE project = ? AND sid = ?")
      .get(record.project, record.sourceSid) as { n: number };
    if (sourceInTarget.n !== 0) {
      fail(errors, `${record.id}: answer session exists in target project`);
    }
    const queryTerms = tokenize(record.query);
    const overlap = db
      .prepare(
        `SELECT max(overlap) AS overlap FROM (
           SELECT count(DISTINCT p.term) AS overlap
           FROM sessions s
           JOIN postings p ON p.sid = s.sid
           WHERE s.project = ? AND p.term IN (SELECT value FROM json_each(?))
           GROUP BY s.sid
         )`,
      )
      .get(record.project, JSON.stringify(queryTerms)) as { overlap: number | null };
    if ((overlap.overlap ?? 0) < 2) {
      fail(errors, `${record.id}: live target project has no meaningful lexical overlap`);
    }
  }
}

function main(): void {
  const errors: string[] = [];
  const positives = readJson<PositiveDoc>("positives.json");
  const known = readJson<PositiveDoc>("known.json");
  const negatives = readJson<NegativeDoc>("negatives.json");
  const holderSnapshot = readJson<HolderSnapshot>("holder-snapshot.json");
  const queries = readJson<QueryDoc>("queries.json");
  const manifest = readJson<Record<string, unknown>>("manifest.json");

  if (positives.count !== 30 || positives.records.length !== 30) {
    fail(errors, `positives: expected 30 records, got ${positives.records.length}`);
  }
  const codexCount = positives.records.filter((record) => record.agent === "codex").length;
  if (codexCount < 25 || codexCount > 30) {
    fail(errors, `positives: expected 25-30 codex records, got ${codexCount}`);
  }
  if (known.count !== 20 || known.records.length !== 20) {
    fail(errors, `known: expected 20 records, got ${known.records.length}`);
  }
  if (manifest.schemaVersion !== 1) {
    fail(errors, "manifest: schemaVersion must be 1");
  }
  const manifestHashes = manifest.sha256 as Record<string, string> | undefined;
  for (const file of [
    "positives.json",
    "known.json",
    "negatives.json",
    "queries.json",
    "holder-snapshot.json",
  ]) {
    const actual = createHash("sha256").update(readFileSync(join(BENCH_DIR, file))).digest("hex");
    if (!manifestHashes || manifestHashes[file] !== actual) {
      fail(errors, `manifest: checksum mismatch for ${file}`);
    }
  }
  if (holderSnapshot.schemaVersion !== 1) {
    fail(errors, "holder-snapshot: schemaVersion must be 1");
  }
  if (holderSnapshot.corpusCutoff !== positives.corpusCutoff) {
    fail(errors, "holder-snapshot: corpus cutoff mismatch");
  }
  if (Object.keys(holderSnapshot.entries).length !== 50) {
    fail(
      errors,
      `holder-snapshot: expected 50 entries, got ${Object.keys(holderSnapshot.entries).length}`,
    );
  }
  for (const [key, entry] of Object.entries(holderSnapshot.entries)) {
    if (holderKey(entry.terms) !== key || entry.holders.length !== 1) {
      fail(errors, `holder-snapshot:${key} invalid`);
    }
  }
  if (queries.schemaVersion !== 1) {
    fail(errors, "queries: schemaVersion must be 1");
  }
  if (queries.corpusCutoff !== positives.corpusCutoff) {
    fail(errors, "queries: corpus cutoff mismatch");
  }
  if (queries.count !== 315 || queries.queries.length !== 315) {
    fail(errors, `queries: expected 315 records, got ${queries.queries.length}`);
  }
  if (
    queries.byFamily.positive !== 180 ||
    queries.byFamily.known !== 120 ||
    queries.byFamily.negative !== 15
  ) {
    fail(errors, `queries: unexpected family counts ${JSON.stringify(queries.byFamily)}`);
  }

  const queryIds = new Set<string>();
  const normalizedQueries = new Set<string>();
  for (const item of queries.queries) {
    if (queryIds.has(item.id)) {
      fail(errors, `queries: duplicate id ${item.id}`);
    }
    queryIds.add(item.id);
    const normalized = item.query.trim().replace(/\s+/g, " ");
    if (!normalized) {
      fail(errors, `queries:${item.id} empty query`);
    }
    if (normalizedQueries.has(normalized)) {
      fail(errors, `queries: duplicate query ${item.id}`);
    }
    normalizedQueries.add(normalized);
    if (item.family === "negative") {
      if (item.sid !== null) {
        fail(errors, `queries:${item.id} negative has answer sid`);
      }
      continue;
    }
    if (!item.sid) {
      fail(errors, `queries:${item.id} has no answer sid`);
      continue;
    }
    assertUniqueHolders(
      errors,
      `queries:${item.id}`,
      item.sid,
      item.answerTerms,
      holderSnapshot,
      null,
    );
  }

  assertNoTranscriptPayload(errors, positives);
  assertNoTranscriptPayload(errors, known);
  assertNoTranscriptPayload(errors, negatives);
  assertNoTranscriptPayload(errors, holderSnapshot);
  assertNoTranscriptPayload(errors, queries);

  let positiveCases = 0;
  let knownCases = 0;
  let uniqueHolderCases = 0;
  const corpusPath = join(TMP_DIR, "corpus.db");
  let db: Database.Database | null = null;
  if (existsSync(corpusPath)) {
    const candidate = new Database(corpusPath, { readonly: true, fileMustExist: true });
    const sessions = candidate.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
    const postings = candidate.prepare("SELECT count(*) AS n FROM postings").get() as { n: number };
    db = sessions.n >= 60 && postings.n >= 1_000 ? candidate : null;
    if (!db) {
      candidate.close();
    }
  }
  const corpusMode = db ? "recomputed" : "holder-snapshot";
  try {
    const positiveResult = checkQueries(errors, db, holderSnapshot, positives.records, "positive");
    const knownResult = checkQueries(errors, db, holderSnapshot, known.records, "known");
    positiveCases = positiveResult.cases;
    knownCases = knownResult.cases;
    uniqueHolderCases = positiveResult.uniqueHolderCases + knownResult.uniqueHolderCases;
    checkNegatives(errors, db, negatives);
  } finally {
    db?.close();
  }

  const result = {
    ok: errors.length === 0,
    corpusMode,
    positives: positives.records.length,
    codex: codexCount,
    claude: positives.records.length - codexCount,
    variantsPerPositive: 5,
    positiveQueryCases: positiveCases,
    known: known.records.length,
    knownQueryCases: knownCases,
    queryFileCases: queries.queries.length,
    holderSnapshotEntries: Object.keys(holderSnapshot.entries).length,
    negatives: negatives.records.length,
    uniqueHolderCases,
    errors,
  };
  writeFileSync(join(BENCH_DIR, "validation.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main();
