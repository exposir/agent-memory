import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { openReadDatabase } from "../src/db.js";
import { buildRecall, type RecallCandidate } from "../src/recall.js";
import { inverseDocumentFrequency, isNamingTerm, topLeadTerms } from "../src/rank.js";
import { normalizeQuery, searchSessions } from "../src/search.js";
import { BENCH_DIR, TMP_DIR } from "./lib/paths.js";

interface QueryCase {
  id: string;
  family: "positive" | "known" | "negative";
  kind: string;
  query: string;
  sid: string | null;
  project: string | null;
}

interface SessionRow {
  id: string;
}

interface MessageRow {
  ordinal: number;
  ts: string;
  role: "user" | "assistant" | "tool_call" | "tool_result";
  kind: string;
  text: string;
}

interface CaseResult {
  id: string;
  family: QueryCase["family"];
  kind: string;
  rank: number | null;
  tier: string;
  ms: number;
  blocked: boolean | null;
  top: string[];
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function sessionMessages(db: ReturnType<typeof openReadDatabase>, sid: string): MessageRow[] {
  return db
    .prepare(
      `SELECT ordinal, ts, role, kind, text
       FROM msgs WHERE sid = ? ORDER BY ordinal`,
    )
    .all(sid) as MessageRow[];
}

function recallAnchors(
  db: ReturnType<typeof openReadDatabase>,
  terms: string[],
): { anchorTerms: string[]; anchorNeed: number } {
  if (terms.length === 0) {
    return { anchorTerms: [], anchorNeed: 0 };
  }
  const corpus = db.prepare("SELECT count(*) AS n FROM sessions").get() as { n: number };
  const rows = db
    .prepare(
      `SELECT term, count(*) AS df FROM session_terms
       WHERE term IN (SELECT value FROM json_each(?))
       GROUP BY term`,
    )
    .all(JSON.stringify(terms)) as Array<{ term: string; df: number }>;
  const byTerm = new Map(rows.map((row) => [row.term, row.df]));
  const idfOf = new Map(
    terms.map((term) => {
      const df = byTerm.get(term) ?? 0;
      return [term, df > 0 ? inverseDocumentFrequency(df, corpus.n) : 0];
    }),
  );
  const known = terms.filter((term) => (byTerm.get(term) ?? 0) > 0);
  const named = known.filter((term) => isNamingTerm(term, idfOf.get(term) ?? 0));
  const selected = topLeadTerms(named.length > 0 ? named : known, idfOf).slice(0, 2);
  return {
    anchorTerms: selected,
    anchorNeed: selected.length > 0 ? 1 : 0,
  };
}

function negativeBlocksForProject(
  db: ReturnType<typeof openReadDatabase>,
  item: QueryCase,
  currentSid: string,
  project: string | null,
): boolean {
  const recallQuery = normalizeQuery(item.query);
  const result = searchSessions(db, recallQuery, {
    limit: 8,
    ...(project ? { project } : {}),
    currentSid,
    now: frozenNow,
  });
  const candidates: RecallCandidate[] = result.hits.slice(0, 3).map((hit) => ({
    sid: hit.sid,
    agent: hit.agent,
    project: hit.project,
    updatedAt: hit.updatedAt,
    messages: sessionMessages(db, hit.sid) as RecallCandidate["messages"],
  }));
  const anchors = recallAnchors(db, result.terms);
  const blocks = buildRecall(recallQuery, candidates, {
    anchorTerms: anchors.anchorTerms,
    anchorNeed: anchors.anchorNeed,
    currentSid,
  });
  return blocks.length > 0;
}

// Claude sessions store the project as the encoded directory name
// (`-work-acme`), codex/opencode store the raw path. A negative is nonempty
// if the recall block survives under either stored form.
function negativeBlocks(
  db: ReturnType<typeof openReadDatabase>,
  item: QueryCase,
  currentSid: string,
): boolean {
  const forms = item.project
    ? [item.project, item.project.replaceAll("/", "-")]
    : [null];
  return forms.some((project) => negativeBlocksForProject(db, item, currentSid, project));
}

function summarize(results: CaseResult[]) {
  const rank1 = results.filter((item) => item.rank === 1).length;
  const recall3 = results.filter((item) => item.rank !== null && item.rank <= 3).length;
  const recall5 = results.filter((item) => item.rank !== null && item.rank <= 5).length;
  const recall10 = results.filter((item) => item.rank !== null && item.rank <= 10).length;
  const missing = results.filter((item) => item.rank === null).length;
  return {
    count: results.length,
    rank1,
    recall3,
    recall5,
    recall10,
    missing,
    p50: percentile(results.map((item) => item.ms), 50),
    p95: percentile(results.map((item) => item.ms), 95),
  };
}

const dbPath = process.env.MEM_EVAL_DB ?? join(TMP_DIR, "mem.db");
const currentSid =
  process.env.MEM_CURRENT_SID ?? "00000000-0000-4000-8000-000000000100";
// Freeze the clock so repeated A/B runs rank identical inputs the same way.
// The value is recorded in the report; changing it changes freshness decay.
const frozenNow = new Date(
  process.env.MEM_EVAL_NOW ?? "2026-01-15T00:00:00.000Z",
);
const queries = JSON.parse(
  readFileSync(join(BENCH_DIR, "queries.json"), "utf8"),
).queries as QueryCase[];
// The 315-set embeds the project name in each negative query so a reader can
// see the scope. That prefix itself matches sessions, so judge the negative on
// its original question plus the explicit project filter instead.
const rawNegatives = JSON.parse(
  readFileSync(join(BENCH_DIR, "negatives.json"), "utf8"),
).records as Array<{ id: string; query: string }>;
const rawNegativeQuery = new Map(
  rawNegatives.map((item) => [item.id, item.query]),
);

const db = openReadDatabase(dbPath);
const startedAt = performance.now();
const results: CaseResult[] = [];
for (const item of queries) {
  if (item.family === "negative") {
    const started = performance.now();
    const raw = rawNegativeQuery.get(item.id.split(":")[0] ?? "");
    const query = raw ?? item.query;
    const blocked = negativeBlocks(db, { ...item, query }, currentSid);
    results.push({
      id: item.id,
      family: item.family,
      kind: item.kind,
      rank: null,
      tier: "recall",
      ms: Math.round((performance.now() - started) * 10) / 10,
      blocked,
      top: [],
    });
    continue;
  }
  const started = performance.now();
  const result = searchSessions(db, item.query, {
    limit: 10,
    currentSid,
    now: frozenNow,
  });
  const rank = result.hits.findIndex((hit) => hit.sid === item.sid) + 1 || null;
  results.push({
    id: item.id,
    family: item.family,
    kind: item.kind,
    rank,
    tier: result.tier,
    ms: Math.round((performance.now() - started) * 10) / 10,
    blocked: null,
    top: result.hits.map((hit) => hit.sid),
  });
}
db.close();

const positives = results.filter((item) => item.family === "positive");
const known = results.filter((item) => item.family === "known");
const gatePositive = results.filter(
  (item) => item.family === "positive" && item.kind === "original",
);
const gateKnown = results.filter(
  (item) => item.family === "known" && item.kind === "original",
);
const negatives = results.filter((item) => item.family === "negative");

const byKind: Record<string, ReturnType<typeof summarize>> = {};
for (const kind of [...new Set(results.filter((item) => item.family !== "negative").map((item) => item.kind))]) {
  byKind[kind] = summarize(
    results.filter((item) => item.family !== "negative" && item.kind === kind),
  );
}

const report = {
  dbPath,
  currentSid,
  now: frozenNow.toISOString(),
  elapsedMs: Math.round(performance.now() - startedAt),
  gate: {
    positive: summarize(gatePositive),
    known: summarize(gateKnown),
  },
  positives: summarize(positives),
  known: summarize(known),
  byKind,
  negatives: {
    count: negatives.length,
    nonempty: negatives.filter((item) => item.blocked).length,
    p50: percentile(negatives.map((item) => item.ms), 50),
    p95: percentile(negatives.map((item) => item.ms), 95),
  },
  results,
};

const outputPath = process.env.MEM_EVAL_OUT ?? join(BENCH_DIR, "method-report.json");
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      gate_positive: `${report.gate.positive.rank1}/${report.gate.positive.count} rank1, R@3 ${report.gate.positive.recall3}`,
      gate_known: `${report.gate.known.rank1}/${report.gate.known.count} rank1, R@3 ${report.gate.known.recall3}`,
      positives: `${report.positives.rank1}/${report.positives.count} rank1, R@3 ${report.positives.recall3}`,
      known: `${report.known.rank1}/${report.known.count} rank1, R@3 ${report.known.recall3}`,
      byKind: Object.fromEntries(
        Object.entries(byKind).map(([kind, value]) => [
          kind,
          `${value.rank1}/${value.count} rank1, R@3 ${value.recall3}`,
        ]),
      ),
      negatives: `${report.negatives.nonempty}/${report.negatives.count} nonempty`,
      p50: report.positives.p50,
      p95: report.positives.p95,
      elapsedMs: report.elapsedMs,
    },
    null,
    2,
  ),
);
