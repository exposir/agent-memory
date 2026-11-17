import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { openDatabase } from "../src/db.js";
import { searchSessions } from "../src/search.js";
import { BENCH_DIR } from "./lib/paths.js";

interface PositiveCase {
  id: string;
  query: string;
  sid: string;
}

interface KnownCase {
  id: string;
  query: string;
  sid: string;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

const dbPath = process.env.MEM_EVAL_DB ?? ".bench-tmp/mem.db";
// A regression gate must vary only the code under test. `freshnessDecay`
// depends on wall-clock time, so a frozen corpus re-judged a day later can
// lose rank-1 questions with no code change. Freeze the clock at the corpus
// evaluation moment; `MEM_EVAL_NOW=live` opts back into the real clock.
const frozenNow =
  process.env.MEM_EVAL_NOW === "live"
    ? null
    : new Date(process.env.MEM_EVAL_NOW ?? "2026-01-15T00:00:00.000Z");
const positives = JSON.parse(readFileSync(join(BENCH_DIR, "positives.json"), "utf8")) as {
  records: PositiveCase[];
};
const known = JSON.parse(readFileSync(join(BENCH_DIR, "known.json"), "utf8")) as {
  records: KnownCase[];
};
const negatives = JSON.parse(readFileSync(join(BENCH_DIR, "negatives.json"), "utf8")) as {
  records: { id: string; query: string; sourceSid: string; project: string }[];
};
const currentSid =
  process.env.MEM_CURRENT_SID ?? "00000000-0000-4000-8000-000000000100";
const extraExcluded = process.env.MEM_EXCLUDED_SIDS?.split(",").filter(Boolean) ?? [];

const db = openDatabase(dbPath);
const auto = positives.records.map((item) => {
  const result = searchSessions(db, item.query, {
    limit: 5,
    currentSid,
    excludedSids: extraExcluded,
    ...(frozenNow ? { now: frozenNow } : {}),
  });
  const rank = result.hits.findIndex((hit) => hit.sid === item.sid) + 1 || null;
  return {
    ...item,
    rank,
    tier: result.tier,
    ms: result.elapsedMs,
    top: result.hits.map((hit) => hit.sid),
  };
});
const knownResults = known.records.map((item) => {
  const result = searchSessions(db, item.query, {
    limit: 5,
    currentSid,
    excludedSids: extraExcluded,
    ...(frozenNow ? { now: frozenNow } : {}),
  });
  const rank = result.hits.findIndex((hit) => hit.sid === item.sid) + 1 || null;
  return {
    ...item,
    rank,
    tier: result.tier,
    ms: result.elapsedMs,
    top: result.hits.map((hit) => hit.sid),
  };
});
// Cross-project negatives: the answer lives in another project, so a search
// scoped to `project` must not surface the source session. Any other hit is
// allowed — the gate only proves the answer does not leak across projects.
// Claude sessions store the project as the encoded directory name
// (`-work-acme`), codex/opencode store the raw path; scope to both forms.
const negativeResults = negatives.records.flatMap((item) =>
  [item.project, item.project.replaceAll("/", "-")].map((project) => {
    const result = searchSessions(db, `在 ${item.project} 项目里查：${item.query}`, {
      limit: 5,
      currentSid,
      project,
      excludedSids: extraExcluded,
      ...(frozenNow ? { now: frozenNow } : {}),
    });
    const leaked = result.hits.some((hit) => hit.sid === item.sourceSid);
    return {
      ...item,
      scopedProject: project,
      leaked,
      hits: result.hits.length,
      tier: result.tier,
      ms: result.elapsedMs,
    };
  }),
);
db.close();

const autoRank1 = auto.filter((item) => item.rank === 1).length;
const autoRecall3 = auto.filter((item) => item.rank !== null && item.rank <= 3).length;
const autoRecall5 = auto.filter((item) => item.rank !== null && item.rank <= 5).length;
const knownRank1 = knownResults.filter((item) => item.rank === 1).length;
const knownRecall3 = knownResults.filter((item) => item.rank !== null && item.rank <= 3).length;
const report = {
  dbPath,
  currentSid,
  excluded: extraExcluded,
  now: frozenNow ? frozenNow.toISOString() : "live",
  auto: {
    count: auto.length,
    rank1: autoRank1,
    recall3: autoRecall3,
    recall5: autoRecall5,
    p50: percentile(auto.map((item) => item.ms), 50),
    p95: percentile(auto.map((item) => item.ms), 95),
    results: auto,
  },
  known: {
    count: knownResults.length,
    rank1: knownRank1,
    recall3: knownRecall3,
    results: knownResults,
  },
  negatives: {
    count: negativeResults.length,
    leaked: negativeResults.filter((item) => item.leaked).length,
    results: negativeResults,
  },
};
writeFileSync(join(BENCH_DIR, "search-report.json"), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  JSON.stringify(
    {
      auto_rank1: `${autoRank1}/${auto.length}`,
      auto_recall3: `${autoRecall3}/${auto.length}`,
      auto_recall5: `${autoRecall5}/${auto.length}`,
      known_rank1: `${knownRank1}/${knownResults.length}`,
      known_recall3: `${knownRecall3}/${knownResults.length}`,
      negative_leaked: `${report.negatives.leaked}/${negativeResults.length}`,
      p50: report.auto.p50,
      p95: report.auto.p95,
    },
    null,
    2,
  ),
);
