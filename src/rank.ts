import { carriesTerm, normalizeText, termHits, windowSpan } from "./tokenize.js";
import type { AgentName } from "./types.js";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
// BM25+ (Lv & Zhai, 2011): a small per-term lower bound stops length
// normalization from over-penalizing long transcripts. 0.1 was the only value
// that improved the 315-case A/B without moving any query down.
export const BM25_DELTA = 0.1;
export const USER_ROLE_BOOST = 1.3;
export const DECISION_BOOST = 2.0;
export const PASTE_PENALTY = 0.5;
export const GAVE_UP_PENALTY = 0.5;
export const PROMOTED_NOTE_BOOST = 1.25;
export const DIRECT_BOOST = 1.1;
export const PROXIMITY_NEAR = 200;
export const PROXIMITY_MAX = 0.35;
export const TITLE_MAX = 0.4;
export const WORN_SLOPE = 0.1;
export const WORN_CAP = 1.5;

export interface TermFrequency {
  term: string;
  tf: number;
  userTf: number;
  df: number;
}

export interface RankDocument {
  sid: string;
  agent: AgentName;
  project: string | null;
  title: string | null;
  updatedAt: string | null;
  length: number;
  termFrequencies: TermFrequency[];
  matched: number;
  strong: number;
  naming: number;
  minWindow: number;
  titleHits: number;
  decided: boolean;
  pastedEvidence: boolean;
  directQuestion: boolean;
  gaveUp: boolean;
  promotedNote: boolean;
  recallCount: number;
  humanMessages: string[];
}

export interface RankingContext {
  corpusDocuments: number;
  averageLength: number;
  now: Date;
  queryTerms: string[];
}

export interface ScoreBreakdown {
  bm25: number;
  decision: number;
  paste: number;
  gaveUp: number;
  freshness: number;
  proximity: number;
  title: number;
  worn: number;
  note: number;
  direct: number;
  score: number;
}

export const WORKING_WORDS = new Set(
  `
tests test retry build error errors check checks files file patch trace output
command commands branch commits commit deploy deploy fixes fix code read open
task tasks step steps note notes logs log docs doc failure failures prepared
statement statements line lines
文件 代码 测试 构建 错误 报错 修改 检查 任务 步骤 日志 提交 分支 函数 方法
运行 执行 问题 为什 怎么 哪里 哪个 多少 可以 需要 应该 现在 刚才 之前 以前
已经 一下 一个 这个 那个 看下 看看 继续 好的
`
    .trim()
    .split(/\s+/),
);

export function inverseDocumentFrequency(
  documentFrequency: number,
  corpusDocuments: number,
): number {
  return Math.log(
    1 + (corpusDocuments - documentFrequency + 0.5) / (documentFrequency + 0.5),
  );
}

// A message is paste-like when it is at least eight lines and less than 35%
// of its lines are distinct. The search layer applies the paste penalty only
// when the query's lead terms are carried exclusively by such a message: a
// session-level "ever pasted" flag also fires on a normal question that happens
// to sit next to a pasted block, and that is not evidence of a pasted answer.
export function looksPasted(text: string): boolean {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  if (lines.length < 8) {
    return false;
  }
  return new Set(lines).size / lines.length < 0.35;
}

export function freshnessDecay(updatedAt: string | null, now: Date): number {
  if (!updatedAt) {
    return 1;
  }
  const updated = Date.parse(updatedAt);
  if (Number.isNaN(updated)) {
    return 1;
  }
  const ageDays = (now.getTime() - updated) / 86_400_000;
  if (ageDays <= 0) {
    return 1;
  }
  return 0.5 + 0.5 / (1 + ageDays);
}

// The paste penalty is for sessions whose only query evidence is pasted text.
// A normal human question next to a pasted block is not evidence of a pasted
// answer; the session-level "ever pasted" flag cannot tell those apart.
export function onlyPastedLeadEvidence(
  messages: readonly string[],
  leadTerms: readonly string[],
): boolean {
  let pasted = false;
  for (const message of messages) {
    if (!leadTerms.some((term) => carriesTerm(message, term))) {
      continue;
    }
    if (!looksPasted(message)) {
      return false;
    }
    pasted = true;
  }
  return pasted;
}

export function proximityBoost(window: number, queryTokenCount: number): number {
  if (window <= 0 || queryTokenCount < 2) {
    return 1;
  }
  return 1 + PROXIMITY_MAX * (PROXIMITY_NEAR / (PROXIMITY_NEAR + window));
}

export function titleBoost(titleHits: number, queryTokenCount: number): number {
  if (titleHits <= 0 || queryTokenCount === 0) {
    return 1;
  }
  return 1 + TITLE_MAX * (titleHits / queryTokenCount);
}

export function wornBoost(count: number): number {
  return Math.min(WORN_CAP, 1 + WORN_SLOPE * Math.log2(1 + count));
}

export function bm25Score(doc: RankDocument, context: RankingContext): number {
  let score = 0;
  for (const item of doc.termFrequencies) {
    if (item.tf === 0) {
      continue;
    }
    const idf = inverseDocumentFrequency(item.df, context.corpusDocuments);
    const normalization =
      1 - BM25_B +
      BM25_B * (context.averageLength > 0 ? doc.length / context.averageLength : 0);
    const denominator = item.tf + BM25_K1 * normalization;
    score += idf * ((item.tf * (BM25_K1 + 1)) / denominator + BM25_DELTA);
    if (item.userTf > 0) {
      score +=
        idf *
        (item.userTf * (BM25_K1 + 1)) /
        denominator *
        (USER_ROLE_BOOST - 1);
    }
  }
  return score;
}

export function scoreDocument(doc: RankDocument, context: RankingContext): ScoreBreakdown {
  const bm25 = bm25Score(doc, context);
  const decision = doc.decided ? DECISION_BOOST : 1;
  const paste = doc.pastedEvidence && !doc.decided ? PASTE_PENALTY : 1;
  const gaveUp = doc.gaveUp && !doc.decided ? GAVE_UP_PENALTY : 1;
  const freshness = freshnessDecay(doc.updatedAt, context.now);
  const proximity = proximityBoost(doc.minWindow, context.queryTerms.length);
  const title =
    doc.title !== null && doc.title.trim() !== ""
      ? titleBoost(doc.titleHits, context.queryTerms.length)
      : 1;
  const worn = wornBoost(doc.recallCount);
  const note = doc.promotedNote ? PROMOTED_NOTE_BOOST : 1;
  const direct = doc.directQuestion ? DIRECT_BOOST : 1;
  // gave_up is a conclusion-quality signal. It is reported in the breakdown
  // for the recall layer, but must not demote the whole session in search.
  const score = bm25 * decision * paste * freshness * proximity * title * worn * note * direct;
  return { bm25, decision, paste, gaveUp, freshness, proximity, title, worn, note, direct, score };
}

export function isNamingTerm(term: string, idf = 0): boolean {
  const normalized = normalizeText(term);
  if (/[0-9_./-]/.test(normalized) || normalized.length >= 6) {
    return true;
  }
  const isCjk = /[㐀-䶿一-鿿]/.test(normalized);
  return isCjk && normalized.length >= 2 && !WORKING_WORDS.has(normalized) && idf >= 4;
}

// A term is identifier-shaped only when it carries a digit or a path/separator
// character. Plain words and CJK bigrams earn the naming exception only when
// a human message or the project name carries them.
function isIdentifierShaped(term: string): boolean {
  return /[0-9_./:-]/.test(normalizeText(term));
}

export function hasIdentifierTerm(
  terms: readonly string[],
  idfOf: ReadonlyMap<string, number> = new Map(),
): boolean {
  return terms.some((term) => isNamingTerm(term, idfOf.get(term) ?? 0));
}

export function worthShowing(
  doc: RankDocument,
  queryTerms: readonly string[],
  idfOf: ReadonlyMap<string, number> = new Map(),
): boolean {
  return worthShowingCounts(doc.matched, doc.naming, queryTerms, idfOf);
}

export function worthShowingCounts(
  matched: number,
  naming: number,
  queryTerms: readonly string[],
  idfOf: ReadonlyMap<string, number> = new Map(),
): boolean {
  if (matched < 1) {
    return false;
  }
  if (hasIdentifierTerm(queryTerms, idfOf)) {
    return naming >= 1;
  }
  return matched >= 2;
}

function projectCarriesTerm(project: string | null, term: string): boolean {
  if (!project) {
    return false;
  }
  const normalizedProject = normalizeText(project);
  return (
    carriesTerm(normalizedProject, term) ||
    normalizedProject
      .split(/[^a-z0-9]+/)
      .some((segment) => segment === normalizeText(term))
  );
}

function speechCarriesAny(message: string, term: string): boolean {
  return carriesTerm(message, term);
}

function speechCarriesTogether(messages: readonly string[], terms: readonly string[], need: number): boolean {
  return messages.some((message) => termHits(message, terms) >= need);
}

export function leadTermsMeet(
  doc: RankDocument,
  queryTerms: readonly string[],
  idfOf: ReadonlyMap<string, number>,
): boolean {
  return leadTermsSatisfied(
    doc.humanMessages,
    doc.project,
    queryTerms,
    idfOf,
    doc.naming,
  );
}

export function leadTermsSatisfied(
  humanMessages: readonly string[],
  project: string | null,
  queryTerms: readonly string[],
  idfOf: ReadonlyMap<string, number>,
  naming = 0,
): boolean {
  if (queryTerms.length === 0) {
    return false;
  }
  const leadTerms = topLeadTerms(queryTerms, idfOf);
  const named = leadTerms.filter((term) => isNamingTerm(term, idfOf.get(term) ?? 0));

  // A matched term of art identifies the session on its own. This is the
  // documented exception to "two lead words in one human message". A plain
  // English word or CJK bigram is only a term of art when human speech or the
  // project name carries it; only identifier-shaped terms may live in tool
  // output alone.
  if (named.length > 0 && naming > 0) {
    return named.some(
      (term) =>
        humanMessages.some((message) => speechCarriesAny(message, term)) ||
        projectCarriesTerm(project, term) ||
        isIdentifierShaped(term),
    );
  }

  if (named.length >= 2) {
    for (const term of named) {
      const spoken = humanMessages.some((message) => speechCarriesAny(message, term));
      if (
        !spoken &&
        !projectCarriesTerm(project, term) &&
        !isNamingTerm(term, idfOf.get(term) ?? 0)
      ) {
        return false;
      }
    }
    return speechCarriesTogether(humanMessages, named, 2);
  }

  if (named.length === 1) {
    return (
      humanMessages.some((message) => speechCarriesAny(message, named[0]!)) ||
      projectCarriesTerm(project, named[0]!) ||
      isIdentifierShaped(named[0]!)
    );
  }

  return speechCarriesTogether(humanMessages, leadTerms, 2);
}

export function topLeadTerms(
  queryTerms: readonly string[],
  idfOf: ReadonlyMap<string, number>,
): string[] {
  return [...queryTerms]
    .sort((left, right) => (idfOf.get(right) ?? 0) - (idfOf.get(left) ?? 0))
    .slice(0, 3);
}

export function proximityForMessages(messages: readonly string[], terms: readonly string[]): number {
  let best = 0;
  for (const message of messages) {
    const span = windowSpan(message, terms);
    if (span > 0 && (best === 0 || span < best)) {
      best = span;
    }
  }
  return best;
}
