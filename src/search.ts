import Database from "better-sqlite3";

import { openDatabase } from "./db.js";
import {
  WORKING_WORDS,
  isNamingTerm,
  leadTermsMeet,
  onlyPastedLeadEvidence,
  proximityForMessages,
  scoreDocument,
  topLeadTerms,
  worthShowing,
  worthShowingCounts,
  type RankDocument,
  type TermFrequency,
} from "./rank.js";
import { carriesTerm, ftsAnd, ftsOr, ftsPrefixAnd, termHits, tokenize } from "./tokenize.js";
import type { SearchHit } from "./types.js";

const CANDIDATE_LIMIT = 32;
const FTS_SCAN_LIMIT = 4_096;
const MESSAGE_SCAN_LIMIT = 512;
const HUMAN_FALLBACK_SCAN_LIMIT = 128;
// Long natural-language queries cannot satisfy an all-terms AND. Keep the
// eight highest-IDF indexed terms for a focused AND tier before falling back
// to an OR over everything.
const QUERY_CUTOFF = 8;
// An OOV term is dropped from that AND tier. When that happens, read up to
// four matching human messages per candidate rather than a single global
// window, so a long session's speech still reaches the gate.
const HUMAN_PER_SESSION = 4;
// A short user question that carries most lead terms is direct evidence: the
// session contains the ask itself, not just mentions of its words.
const DIRECT_QUESTION_MAX_CHARS = 300;
// BM25's length term over-penalizes marathon sessions that really discuss the
// topic. Cap the effective length at a multiple of the corpus average; the
// term-frequency signal then decides between very long candidates.
const LENGTH_CAP_FACTOR = 2;
// A rare path token inside the query is a fielded constraint. A session that
// carries the exact path is far more likely to be the one that did the work.
const EMBEDDED_PATH_IDF = 3.5;
const NON_PATH_HIT_SCALE = 0.6;
// Drop a short conversational frame before the first colon ("想确认一下：…",
// "同步配置时：…"). Only a clause ending in a spoken discourse marker counts;
// a content label such as "修复清单：" is kept.
const FRAME_END = /(?:一下|请问|问一下|想问|想问下|顺便问|请教|时|的时候|场景|情况)$/;

export function stripQueryFrame(query: string): string {
  const colon = query.search(/[：:]/);
  if (colon < 0) {
    return query;
  }
  const prefix = query.slice(0, colon).trim();
  const suffix = query.slice(colon + 1).trim();
  if (
    prefix.length === 0 ||
    prefix.length > 40 ||
    suffix.length < 10 ||
    suffix.length < prefix.length ||
    /[/\\~]/.test(prefix) ||
    !FRAME_END.test(prefix)
  ) {
    return query;
  }
  return suffix;
}

// A parenthesized path hint is a fielded signal, not body text. Strip it from
// the query terms so it cannot dilute the gate; the hint still boosts
// sessions that carry every path token.
const PATH_BOOST = 1.05;

export function extractPathHint(query: string): { query: string; path: string | null } {
  const match = query.match(
    /（(?:相关)?路径：([^）]+)）|\((?:相关)?路径[:：]([^)]+)\)/,
  );
  if (!match) {
    return { query, path: null };
  }
  const path = (match[1] ?? match[2] ?? "").trim();
  const stripped = `${query.slice(0, match.index)}${query.slice(
    (match.index ?? 0) + match[0].length,
  )}`.trim();
  return { query: stripped, path: path || null };
}

export function normalizeQuery(query: string): string {
  return stripQueryFrame(extractPathHint(query).query);
}

// Repair an OOV ASCII token by enumerating every term one edit away (same
// length only; insertion/deletion neighbors are too ambiguous) and keeping
// the most frequent term the corpus actually has. A candidate already present
// in the query wins over frequency.
function oneEditNeighbors(term: string): string[] {
  const output = new Set<string>();
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (let index = 0; index < term.length; index += 1) {
    for (const letter of letters) {
      output.add(term.slice(0, index) + letter + term.slice(index + 1));
    }
    const next = term[index + 1];
    if (next !== undefined && next !== term[index]) {
      output.add(
        term.slice(0, index) + next + term[index] + term.slice(index + 2),
      );
    }
  }
  output.delete(term);
  return [...output];
}

function correctOovTerms(
  db: Database.Database,
  terms: string[],
  df: ReadonlyMap<string, number>,
  query: string,
): string[] | null {
  const oov = terms.filter(
    (term) => (df.get(term) ?? 0) === 0 && /^[a-z][a-z_-]{3,19}$/.test(term),
  );
  const queryTerms = new Set(terms);
  const segments = new Set(terms.flatMap((term) => term.split(/[._/-]+/)));
  const mapping = new Map<string, string>();
  const lookup = db.prepare(
    `SELECT term, count(*) AS df FROM session_terms
     WHERE term IN (SELECT value FROM json_each(?))
     GROUP BY term`,
  );
  for (const term of oov) {
    const neighbors = oneEditNeighbors(term).filter(
      (neighbor) => !WORKING_WORDS.has(neighbor),
    );
    const rows = lookup.all(JSON.stringify(neighbors)) as Array<{
      term: string;
      df: number;
    }>;
    const candidates = rows
      .filter((row) => row.df >= 5)
      .sort((left, right) => right.df - left.df || left.term.localeCompare(right.term));
    const supported = candidates.find(
      (row) => queryTerms.has(row.term) || segments.has(row.term),
    );
    const best = candidates[0];
    const runnerUp = candidates[1];
    if (supported) {
      mapping.set(term, supported.term);
    } else if (best && (!runnerUp || best.df >= runnerUp.df * 2)) {
      mapping.set(term, best.term);
    }
  }
  // A concrete path is a fielded constraint. If one segment is misspelled,
  // look for the one-edit neighbor that makes the whole path exist in the
  // corpus; only a unique (or 2x dominant) existing path is accepted.
  const pathVariants: Array<{
    original: string;
    variant: string;
    oldPart: string;
    newPart: string;
  }> = [];
  for (const pathTerm of terms) {
    if ((df.get(pathTerm) ?? 0) > 0 || !pathTerm.includes("/") || /\s/.test(pathTerm)) {
      continue;
    }
    const parts = pathTerm.split("/");
    const variants = new Set<string>();
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index]!;
      const mapped = mapping.get(part);
      let replacements: string[] | null = null;
      if (mapped !== undefined) {
        replacements = [mapped];
      } else if (/^[a-z-]{2,19}$/.test(part)) {
        replacements = oneEditNeighbors(part).filter(
          (neighbor) => !WORKING_WORDS.has(neighbor),
        );
      }
      if (replacements === null) {
        continue;
      }
      for (const replacement of replacements) {
        if (replacement === part) {
          continue;
        }
        const variantParts = parts.slice();
        variantParts[index] = replacement;
        const variant = variantParts.join("/");
        if (variants.has(variant)) {
          continue;
        }
        variants.add(variant);
        pathVariants.push({ original: pathTerm, variant, oldPart: part, newPart: replacement });
      }
    }
  }
  if (pathVariants.length > 0) {
    const rows = lookup.all(
      JSON.stringify([...new Set(pathVariants.map((item) => item.variant))]),
    ) as Array<{ term: string; df: number }>;
    const byVariant = new Map(rows.map((row) => [row.term, row.df]));
    const groups = new Map<
      string,
      Array<{ variant: string; df: number; oldPart: string; newPart: string }>
    >();
    for (const item of pathVariants) {
      const count = byVariant.get(item.variant) ?? 0;
      if (count <= 0) {
        continue;
      }
      const list = groups.get(item.original) ?? [];
      list.push({ ...item, df: count });
      groups.set(item.original, list);
    }
    for (const [original, list] of groups) {
      const sorted = [...list].sort(
        (left, right) => right.df - left.df || left.variant.localeCompare(right.variant),
      );
      const best = sorted[0]!;
      const runnerUp = sorted[1];
      if (runnerUp && best.df < runnerUp.df * 2) {
        continue;
      }
      mapping.set(original, best.variant);
      mapping.set(best.oldPart, best.newPart);
    }
  }
  // CJK has no spaces. A short run whose adjacent bigrams include a rare one
  // can be a transposed phrase. Accept a permutation only when every resulting
  // bigram is common (min df >= 20) and the total bigram log-frequency is
  // clearly higher than the original.
  const cjkRuns = query.match(/[㐀-䶿一-鿿]{2,4}/g) ?? [];
  for (const run of new Set(cjkRuns)) {
    const chars = [...run];
    const originalBigrams = chars
      .slice(0, -1)
      .map((char, index) => char + chars[index + 1]!);
    const rare = originalBigrams.some((bigram) => (df.get(bigram) ?? 0) < 10);
    if (!rare) {
      continue;
    }
    const variants = new Set<string>();
    const permute = (prefix: string, rest: string[]): void => {
      if (rest.length === 0) {
        variants.add(prefix);
        return;
      }
      for (let index = 0; index < rest.length; index += 1) {
        permute(prefix + rest[index]!, [
          ...rest.slice(0, index),
          ...rest.slice(index + 1),
        ]);
      }
    };
    permute("", chars);
    const allBigrams = new Set<string>();
    for (const variant of variants) {
      const variantChars = [...variant];
      for (let index = 0; index < variantChars.length - 1; index += 1) {
        allBigrams.add(variantChars[index]! + variantChars[index + 1]!);
      }
    }
    const rows = lookup.all(JSON.stringify([...allBigrams])) as Array<{
      term: string;
      df: number;
    }>;
    const byBigram = new Map(rows.map((row) => [row.term, row.df]));
    const originalScore = originalBigrams.reduce(
      (sum, bigram) => sum + Math.log(1 + (byBigram.get(bigram) ?? 0)),
      0,
    );
    const scored: Array<{ run: string; score: number; minDf: number }> = [];
    for (const variant of variants) {
      if (variant === run) {
        continue;
      }
      const variantChars = [...variant];
      const bigrams = variantChars
        .slice(0, -1)
        .map((char, index) => char + variantChars[index + 1]!);
      const counts = bigrams.map((bigram) => byBigram.get(bigram) ?? 0);
      if (counts.some((count) => count <= 0)) {
        continue;
      }
      scored.push({
        run: variant,
        score: counts.reduce((sum, count) => sum + Math.log(1 + count), 0),
        minDf: Math.min(...counts),
      });
    }
    scored.sort((left, right) => right.score - left.score || left.run.localeCompare(right.run));
    const best = scored[0];
    const runnerUp = scored[1];
    if (
      !best ||
      (runnerUp && runnerUp.score === best.score) ||
      best.minDf < 20 ||
      best.score < originalScore * 1.5
    ) {
      continue;
    }
    const bestChars = [...best.run];
    const bestBigrams = bestChars
      .slice(0, -1)
      .map((char, index) => char + bestChars[index + 1]!);
    for (let index = 0; index < originalBigrams.length; index += 1) {
      if (originalBigrams[index] !== bestBigrams[index]) {
        mapping.set(originalBigrams[index]!, bestBigrams[index]!);
      }
    }
  }
  // "acme-eaily" -> "acme-daily" also repairs the split token "eaily".
  for (const [oldTerm, newTerm] of mapping) {
    const oldParts = oldTerm.split(/([._/-])/);
    const newParts = newTerm.split(/([._/-])/);
    if (oldParts.length !== newParts.length || oldParts.length < 3) {
      continue;
    }
    for (let index = 0; index < oldParts.length; index += 2) {
      const oldPart = oldParts[index]!;
      const newPart = newParts[index]!;
      if (oldPart !== newPart && queryTerms.has(oldPart)) {
        mapping.set(oldPart, newPart);
      }
    }
  }
  let changed = false;
  const output = terms.map((term) => {
    const corrected = mapping.get(term);
    if (corrected === undefined) {
      return term;
    }
    changed = true;
    return corrected;
  });
  return changed ? [...new Set(output)] : null;
}

export type SearchTier = "exact" | "focused" | "stemmed" | "bigram" | "relevance";

export interface SearchOptions {
  limit?: number;
  project?: string;
  currentSid?: string;
  excludedSids?: Iterable<string>;
  now?: Date;
}

export interface SearchResult {
  query: string;
  terms: string[];
  tier: SearchTier;
  hits: SearchHit[];
  total: number;
  capped: boolean;
  elapsedMs: number;
}

interface FtsRow {
  sid: string;
  id: number;
  role: string;
  ordinal: number;
}

interface SessionRow {
  id: string;
  agent: SearchHit["agent"];
  project: string | null;
  title: string | null;
  updated_at: string | null;
  words: number;
  settled: number;
  gave_up: number;
  pasted: number;
}

interface CandidateSeed {
  session: SessionRow;
  termFrequencies: TermFrequency[];
  matched: number;
  strong: number;
  naming: number;
  preliminary: number;
}

interface MatchRow {
  id: number;
  sid: string;
  role: string;
  ordinal: number;
  text: string;
}

function queryFts(
  db: Database.Database,
  match: string,
  project: string | undefined,
  excluded: string[],
): FtsRow[] {
  const projectClause = project ? "AND s.project = ?" : "";
  const params: unknown[] = [match];
  if (project) {
    params.push(project);
  }
  params.push(JSON.stringify(excluded), FTS_SCAN_LIMIT);
  return db
    .prepare(
      `SELECT m.sid, m.id, m.role, m.ordinal
       FROM msgs_fts
       JOIN msgs m ON m.id = msgs_fts.rowid
       JOIN sessions s ON s.id = m.sid
       WHERE msgs_fts MATCH ?
         ${projectClause}
         AND m.sid NOT IN (SELECT value FROM json_each(?))
       ORDER BY bm25(msgs_fts), m.id
       LIMIT ?`,
    )
    .all(...params) as FtsRow[];
}

function fallbackQueries(
  terms: string[],
  df: ReadonlyMap<string, number>,
  idfOf: ReadonlyMap<string, number>,
): Array<{ tier: SearchTier; match: string }> {
  const exact = ftsAnd(terms);
  const stems = terms.map((term) => (term.length >= 7 ? term.slice(0, -2) : term));
  const stemmed = ftsPrefixAnd(stems);
  const cjk = terms.filter(
    (term) => term.length === 2 && /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(term),
  );
  // A mixed query must not stop at the CJK subset: matching only its Chinese
  // words produces a plausible-looking candidate that lacks the identifier.
  // This vocabulary already uses bigrams, so the bigram tier is only useful
  // when every query term is CJK.
  const bigram = cjk.length === terms.length ? ftsAnd(cjk) : "";
  const relevance = ftsOr(terms);
  // A long natural-language query cannot satisfy an all-terms AND; its rare
  // words still identify the session. Keep the highest-IDF indexed terms and
  // require those together before falling back to an OR over everything.
  const core = [...terms]
    .filter((term) => (df.get(term) ?? 0) > 0 && !WORKING_WORDS.has(term))
    .sort(
      (left, right) =>
        (idfOf.get(right) ?? 0) - (idfOf.get(left) ?? 0) ||
        left.localeCompare(right),
    )
    .slice(0, QUERY_CUTOFF);
  const focused = core.length >= 2 ? ftsAnd(core) : "";
  const layers: Array<{ tier: SearchTier; match: string }> = [
    { tier: "exact", match: exact },
    { tier: "stemmed", match: stemmed },
    { tier: "bigram", match: bigram },
    { tier: "focused", match: focused },
    { tier: "relevance", match: relevance },
  ];
  return layers.filter(
    (item, index, all) =>
      item.match.length > 0 &&
      all.findIndex((candidate) => candidate.match === item.match) === index,
  );
}

function candidateSessions(
  db: Database.Database,
  sids: string[],
): Map<string, SessionRow> {
  if (sids.length === 0) {
    return new Map();
  }
  const rows = db
    .prepare(
      `SELECT id, agent, project, title, updated_at, words, settled, gave_up, pasted
       FROM sessions
       WHERE id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(sids)) as SessionRow[];
  return new Map(rows.map((row) => [row.id, row]));
}

function documentFrequencies(
  db: Database.Database,
  terms: string[],
): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT term, count(*) AS df
       FROM session_terms
       WHERE term IN (SELECT value FROM json_each(?))
       GROUP BY term`,
    )
    .all(JSON.stringify(terms)) as Array<{ term: string; df: number }>;
  return new Map(rows.map((row) => [row.term, row.df]));
}

function rareTermCandidateSids(
  db: Database.Database,
  terms: string[],
  df: ReadonlyMap<string, number>,
  project: string | undefined,
  excluded: string[],
): string[] {
  const rare = [...terms]
    .filter((term) => (df.get(term) ?? 0) > 0)
    .sort(
      (left, right) =>
        (df.get(left) ?? 0) - (df.get(right) ?? 0) ||
        left.localeCompare(right),
    )
    .slice(0, 3);
  if (rare.length < 2) {
    return [];
  }
  const projectClause = project ? "AND s.project = ?" : "";
  const statement = db.prepare(
    `SELECT st.sid
     FROM session_terms st
     JOIN sessions s ON s.id = st.sid
     WHERE st.term = ?
       ${projectClause}
       AND st.sid NOT IN (SELECT value FROM json_each(?))
     ORDER BY st.tf DESC, st.sid
     LIMIT 96`,
  );
  const sids = new Set<string>();
  for (const term of rare) {
    const params: unknown[] = [term];
    if (project) {
      params.push(project);
    }
    params.push(JSON.stringify(excluded));
    const rows = statement.all(...params) as Array<{ sid: string }>;
    for (const row of rows) {
      sids.add(row.sid);
    }
  }
  return [...sids];
}

function termFrequencies(
  db: Database.Database,
  sids: string[],
  terms: string[],
  df: ReadonlyMap<string, number>,
): Map<string, TermFrequency[]> {
  const rows = db
    .prepare(
      `SELECT sid, term, tf, user_tf
       FROM session_terms
       WHERE term IN (SELECT value FROM json_each(?))
         AND sid IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(terms), JSON.stringify(sids)) as Array<{
    sid: string;
    term: string;
    tf: number;
    user_tf: number;
  }>;
  const output = new Map<string, TermFrequency[]>();
  for (const row of rows) {
    const list = output.get(row.sid) ?? [];
    list.push({
      term: row.term,
      tf: row.tf,
      userTf: row.user_tf,
      df: df.get(row.term) ?? 0,
    });
    output.set(row.sid, list);
  }
  return output;
}

function rankMessageRows(
  db: Database.Database,
  match: string,
  sids: string[],
): MatchRow[] {
  return db
    .prepare(
      `SELECT m.id, m.sid, m.role, m.ordinal, m.text
       FROM msgs_fts
       JOIN msgs m ON m.id = msgs_fts.rowid
       WHERE msgs_fts MATCH ?
         AND m.sid IN (SELECT value FROM json_each(?))
       ORDER BY bm25(msgs_fts), m.id
       LIMIT ?`,
    )
    .all(match, JSON.stringify(sids), MESSAGE_SCAN_LIMIT) as MatchRow[];
}

function rankHumanMessageRows(
  db: Database.Database,
  match: string,
  sids: string[],
  perSession = 0,
): MatchRow[] {
  if (perSession > 0) {
    return db
      .prepare(
        `SELECT id, sid, role, ordinal, text FROM (
           SELECT m.id, m.sid, m.role, m.ordinal, m.text,
                  row_number() OVER (PARTITION BY m.sid ORDER BY m.id) AS rn
           FROM msgs_fts
           JOIN msgs m ON m.id = msgs_fts.rowid
           WHERE msgs_fts MATCH ?
             AND m.sid IN (SELECT value FROM json_each(?))
             AND m.role IN ('user', 'assistant')
         )
         WHERE rn <= ?`,
      )
      .all(match, JSON.stringify(sids), perSession) as MatchRow[];
  }
  return db
    .prepare(
      `SELECT m.id, m.sid, m.role, m.ordinal, m.text
       FROM msgs_fts
       JOIN msgs m ON m.id = msgs_fts.rowid
       WHERE msgs_fts MATCH ?
         AND m.sid IN (SELECT value FROM json_each(?))
         AND m.role IN ('user', 'assistant')
       ORDER BY m.id
       LIMIT ?`,
    )
    .all(match, JSON.stringify(sids), HUMAN_FALLBACK_SCAN_LIMIT) as MatchRow[];
}

function notePromotions(
  db: Database.Database,
  terms: string[],
  candidateIds: Set<string>,
): Set<string> {
  const notes = db
    .prepare("SELECT source, text FROM notes WHERE state = 'active' AND source IS NOT NULL")
    .all() as Array<{ source: string; text: string }>;
  const promoted = new Set<string>();
  for (const note of notes) {
    if (candidateIds.has(note.source) && termHits(note.text, terms) > 0) {
      promoted.add(note.source);
    }
  }
  return promoted;
}

function recallCounts(
  db: Database.Database,
  candidateIds: string[],
): Map<string, number> {
  if (candidateIds.length === 0) {
    return new Map();
  }
  const rows = db
    .prepare(
      `SELECT sid, count(*) AS n
       FROM recalls
       WHERE sid IN (SELECT value FROM json_each(?))
       GROUP BY sid`,
    )
    .all(JSON.stringify(candidateIds)) as Array<{ sid: string; n: number }>;
  return new Map(rows.map((row) => [row.sid, row.n]));
}

function candidateSeed(
  session: SessionRow,
  frequencies: TermFrequency[],
  queryTerms: string[],
  corpusDocuments: number,
): CandidateSeed {
  const byTerm = new Map(frequencies.map((item) => [item.term, item]));
  let matched = 0;
  let strong = 0;
  let naming = 0;
  let preliminary = 0;
  for (const term of queryTerms) {
    const frequency = byTerm.get(term);
    if (!frequency || frequency.tf === 0) {
      continue;
    }
    matched += 1;
    const idf = Math.log(
      1 + (corpusDocuments - frequency.df + 0.5) / (frequency.df + 0.5),
    );
    if (idf >= 4) {
      strong += 1;
    }
    if (isNamingTerm(term, idf)) {
      naming += 1;
    }
    preliminary += idf * frequency.tf;
  }
  return { session, termFrequencies: frequencies, matched, strong, naming, preliminary };
}

function pathMatchedSids(
  db: Database.Database,
  sids: string[],
  pathTerms: string[],
): Set<string> {
  const terms = [...new Set(pathTerms)];
  if (terms.length < 2 || sids.length === 0) {
    return new Set();
  }
  const rows = db
    .prepare(
      `SELECT sid FROM session_terms
       WHERE term IN (SELECT value FROM json_each(?))
         AND sid IN (SELECT value FROM json_each(?))
       GROUP BY sid
       HAVING count(DISTINCT term) = ?`,
    )
    .all(JSON.stringify(terms), JSON.stringify(sids), terms.length) as Array<{
    sid: string;
  }>;
  return new Set(rows.map((row) => row.sid));
}

function pathTermSids(
  db: Database.Database,
  sids: string[],
  terms: string[],
): Set<string> {
  if (terms.length === 0 || sids.length === 0) {
    return new Set();
  }
  const rows = db
    .prepare(
      `SELECT DISTINCT sid FROM session_terms
       WHERE term IN (SELECT value FROM json_each(?))
         AND sid IN (SELECT value FROM json_each(?))
         AND tf > 0`,
    )
    .all(JSON.stringify(terms), JSON.stringify(sids)) as Array<{ sid: string }>;
  return new Set(rows.map((row) => row.sid));
}

export function searchSessions(
  db: Database.Database,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const started = performance.now();
  const hinted = extractPathHint(query);
  let terms = tokenize(stripQueryFrame(hinted.query));
  if (terms.length === 0) {
    return {
      query,
      terms,
      tier: "exact",
      hits: [],
      total: 0,
      capped: false,
      elapsedMs: Math.round(performance.now() - started),
    };
  }
  const excluded = new Set<string>(options.excludedSids ?? []);
  if (options.currentSid) {
    excluded.add(options.currentSid);
  }
  const now = options.now ?? new Date();
  const limit = Math.max(1, options.limit ?? 15);
  const corpus = db
    .prepare("SELECT count(*) AS n, avg(words) AS avg_words FROM sessions")
    .get() as { n: number; avg_words: number | null };
  const corpusDocuments = Math.max(1, corpus.n);
  const averageLength = Math.max(1, corpus.avg_words ?? 1);
  let df = documentFrequencies(db, terms);
  let idfOf = new Map(
    terms.map((term) => [
      term,
      Math.log(
        1 +
          (corpusDocuments - (df.get(term) ?? 0) + 0.5) /
            ((df.get(term) ?? 0) + 0.5),
      ),
    ]),
  );
  // A repaired typo is no longer OOV, but the original query still was.
  const hadOov = terms.some((term) => (df.get(term) ?? 0) === 0);
  const corrected = correctOovTerms(db, terms, df, stripQueryFrame(hinted.query));
  if (corrected !== null) {
    terms = corrected;
    df = documentFrequencies(db, terms);
    idfOf = new Map(
      terms.map((term) => [
        term,
        Math.log(
          1 +
            (corpusDocuments - (df.get(term) ?? 0) + 0.5) /
              ((df.get(term) ?? 0) + 0.5),
        ),
      ]),
    );
  }

  let tier: SearchTier = "exact";
  let match = ftsAnd(terms);
  let rows: FtsRow[] = [];
  for (const fallback of fallbackQueries(terms, df, idfOf)) {
    rows = queryFts(db, fallback.match, options.project, [...excluded]);
    if (rows.length > 0) {
      tier = fallback.tier;
      match = fallback.match;
      break;
    }
  }
  if (rows.length === 0) {
    return {
      query,
      terms,
      tier: "relevance",
      hits: [],
      total: 0,
      capped: false,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  const orderedSids = [
    ...new Set([
      ...rows.map((row) => row.sid),
      ...rareTermCandidateSids(db, terms, df, options.project, [...excluded]),
    ]),
  ].slice(0, 128);
  const sessions = candidateSessions(db, orderedSids);
  const frequencies = termFrequencies(db, orderedSids, terms, df);
  const seeds = orderedSids
    .map((sid) => {
      const session = sessions.get(sid);
      return session
        ? candidateSeed(session, frequencies.get(sid) ?? [], terms, corpusDocuments)
        : null;
    })
    .filter((seed): seed is CandidateSeed => seed !== null)
    .sort(
      (left, right) =>
        right.matched - left.matched ||
        right.preliminary - left.preliminary ||
        (right.session.updated_at ?? "").localeCompare(left.session.updated_at ?? "") ||
        left.session.id.localeCompare(right.session.id),
    )
    .slice(0, CANDIDATE_LIMIT);

  if (seeds.length === 0) {
    return {
      query,
      terms,
      tier,
      hits: [],
      total: 0,
      capped: false,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  const selectedIds = seeds.map((seed) => seed.session.id);
  const pathTerms = hinted.path ? tokenize(hinted.path) : [];
  const pathSids =
    PATH_BOOST > 1 ? pathMatchedSids(db, selectedIds, pathTerms) : new Set<string>();
  const embeddedPathTerms = terms
    .filter(
      (term) =>
        term.includes("/") &&
        (df.get(term) ?? 0) > 0 &&
        (idfOf.get(term) ?? 0) >= EMBEDDED_PATH_IDF,
    )
    .sort(
      (left, right) =>
        (idfOf.get(right) ?? 0) - (idfOf.get(left) ?? 0) ||
        left.localeCompare(right),
    )
    .slice(0, 1);
  const embeddedPathSids = pathTermSids(db, selectedIds, embeddedPathTerms);
  const gateTerms = new Map(
    seeds.map((seed) => [
      seed.session.id,
      terms.filter((term) =>
        seed.termFrequencies.some(
          (frequency) => frequency.term === term && frequency.tf > 0,
        ),
      ),
    ]),
  );
  const leadBySid = new Map(
    [...gateTerms.entries()].map(([sid, selected]) => [
      sid,
      topLeadTerms(selected, idfOf),
    ]),
  );
  const directLeadUnion = topLeadTerms(
    [...new Set([...gateTerms.values()].flat())],
    idfOf,
  );
  const shortDirectSids = new Set<string>();
  if (directLeadUnion.length >= 2) {
    const shortRows = db
      .prepare(
        `SELECT sid, text FROM (
           SELECT m.sid, m.text,
                  row_number() OVER (PARTITION BY m.sid ORDER BY m.id) AS rn
           FROM msgs_fts
           JOIN msgs m ON m.id = msgs_fts.rowid
           WHERE msgs_fts MATCH ?
             AND m.sid IN (SELECT value FROM json_each(?))
             AND m.role = 'user'
             AND length(m.text) <= ?
         )
         WHERE rn <= 8`,
      )
      .all(
        ftsOr(directLeadUnion),
        JSON.stringify(selectedIds),
        DIRECT_QUESTION_MAX_CHARS,
      ) as Array<{ sid: string; text: string }>;
    for (const row of shortRows) {
      const leads = leadBySid.get(row.sid) ?? [];
      if (leads.filter((term) => carriesTerm(row.text, term)).length >= 2) {
        shortDirectSids.add(row.sid);
      }
    }
  }
  const matchedMessages = rankMessageRows(db, match, selectedIds);
  const messageMap = new Map<string, MatchRow[]>();
  for (const row of matchedMessages) {
    const list = messageMap.get(row.sid) ?? [];
    list.push(row);
    messageMap.set(row.sid, list);
  }
  // A copied tool record may be the only message matching every tier term.
  // For those sessions, gates and proximity still need to read user/assistant
  // speech carrying any of the query terms.
  const humanIds = new Set(
    selectedIds.filter((sid) =>
      (messageMap.get(sid) ?? []).some(
        (message) => message.role === "user" || message.role === "assistant",
      ),
    ),
  );
  const fallbackIds = selectedIds.filter((sid) => {
    const effectiveTerms = gateTerms.get(sid) ?? [];
    return (
      !humanIds.has(sid) &&
      worthShowingCounts(
        seeds.find((seed) => seed.session.id === sid)?.matched ?? 0,
        seeds.find((seed) => seed.session.id === sid)?.naming ?? 0,
        effectiveTerms,
        idfOf,
      )
    );
  });
  if (fallbackIds.length > 0) {
    const fallbackTerms = topLeadTerms(
      [...new Set([...gateTerms.values()].flat())],
      idfOf,
    );
    const usePerSession = hadOov;
    const fallbackMessages = rankHumanMessageRows(
      db,
      ftsOr(fallbackTerms),
      fallbackIds,
      usePerSession ? HUMAN_PER_SESSION : 0,
    );
    for (const row of fallbackMessages) {
      const list = messageMap.get(row.sid) ?? [];
      list.push(row);
      messageMap.set(row.sid, list);
    }
  }
  const promoted = notePromotions(db, terms, new Set(selectedIds));
  const recalls = recallCounts(db, selectedIds);

  const hits: SearchHit[] = [];
  for (const seed of seeds) {
    const messages = messageMap.get(seed.session.id) ?? [];
    const matchedLength = messages.reduce(
      (total, message) => total + tokenize(message.text).length,
      0,
    );
    const effectiveTerms = gateTerms.get(seed.session.id) ?? [];
    const humanMessages = messages
      .filter((message) => message.role === "user" || message.role === "assistant")
      .map((message) => message.text);
    const leadTerms = topLeadTerms(effectiveTerms, idfOf);
    const pastedEvidence = onlyPastedLeadEvidence(humanMessages, leadTerms);
    const directQuestion =
      shortDirectSids.has(seed.session.id) ||
      (leadTerms.length >= 2 &&
        messages.some((message) => {
          if (message.role !== "user" || message.text.length > DIRECT_QUESTION_MAX_CHARS) {
            return false;
          }
          return leadTerms.filter((term) => carriesTerm(message.text, term)).length >= 2;
        }));
    const minWindow = proximityForMessages(
      messages.map((message) => message.text),
      effectiveTerms,
    );
    const title = seed.session.title;
    const titleHits = title
      ? terms.filter((term) => carriesTerm(title, term)).length
      : 0;
    const doc: RankDocument = {
      sid: seed.session.id,
      agent: seed.session.agent,
      project: seed.session.project,
      title,
      updatedAt: seed.session.updated_at,
      // A whole-session length punishes a long transcript that really answers
      // the question. Match-message length alone lets a marathon mention win.
      // The geometric mean keeps both signals bounded, as BM25 length normalization does.
      length: Math.min(
        Math.sqrt(Math.max(1, matchedLength) * Math.max(1, seed.session.words)),
        averageLength * LENGTH_CAP_FACTOR,
      ),
      termFrequencies: seed.termFrequencies,
      matched: seed.matched,
      strong: seed.strong,
      naming: seed.naming,
      minWindow,
      titleHits,
      decided: seed.session.settled !== 0,
      pastedEvidence,
      directQuestion,
      gaveUp: seed.session.gave_up !== 0,
      promotedNote: promoted.has(seed.session.id),
      recallCount: recalls.get(seed.session.id) ?? 0,
      humanMessages,
    };
    // OOV terms (usually a typo or an incidental variant prefix) cannot be
    // required by the gate. Rank them when they match, but judge the gate on
    // the terms this candidate actually carries.
    const worth = worthShowing(doc, effectiveTerms, idfOf);
    const lead = leadTermsMeet(doc, effectiveTerms, idfOf);
    if (
      effectiveTerms.length === 0 ||
      !worth ||
      !lead
    ) {
      continue;
    }
    const baseScore = scoreDocument(doc, {
      corpusDocuments,
      averageLength,
      now,
      queryTerms: effectiveTerms,
    }).score;
    const score =
      (pathSids.has(doc.sid) ? baseScore * PATH_BOOST : baseScore) *
      (embeddedPathSids.size > 0 && !embeddedPathSids.has(doc.sid)
        ? NON_PATH_HIT_SCALE
        : 1);
    hits.push({
      sid: doc.sid,
      agent: doc.agent,
      project: doc.project,
      title: doc.title,
      updatedAt: doc.updatedAt,
      score,
      matched: doc.matched,
      strong: doc.strong,
      naming: doc.naming,
    });
  }

  hits.sort(
    (left, right) =>
      right.score - left.score ||
      (right.updatedAt ?? "").localeCompare(left.updatedAt ?? "") ||
      left.sid.localeCompare(right.sid),
  );
  const total = hits.length;
  return {
    query,
    terms,
    tier,
    hits: hits.slice(0, limit),
    total,
    capped: total > limit,
    elapsedMs: Math.round((performance.now() - started) * 10) / 10,
  };
}

export function searchDatabase(
  dbPath: string,
  query: string,
  options: SearchOptions = {},
): SearchResult {
  const db = openDatabase(dbPath);
  try {
    return searchSessions(db, query, options);
  } finally {
    db.close();
  }
}
