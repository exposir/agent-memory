import type {
  AgentName,
  MessageRole,
  RecallBlock,
  RecallQuote,
} from "./types.js";
import { carriesTerm, normalizeText, termHits, tokenize } from "./tokenize.js";

export const REPLY_WINDOW = 4;
export const CONCLUSION_POLICY = {
  one: { budget: 1_600, limit: 4 },
  two: { budget: 1_000, limit: 3 },
  many: { budget: 400, limit: 2 },
} as const;

export const DECISION_MARKERS = [
  "决定：",
  "决定:",
  "结论：",
  "结论:",
  "原因：",
  "原因:",
  "根因：",
  "根因:",
  "原因是",
  "根因是",
  "最终决定",
  "决定采用",
  "改为",
  "改用",
  "修复了",
  "已修复",
  "修好了",
  "解决了",
  "已解决",
  "已合并",
  "已发布",
  "默认使用",
  "定位到",
  "最终",
  "最后",
  "确认",
  "搞定",
  "decision:",
  "root cause",
  "the fix",
  "fixed by",
  "resolved by",
  "we decided",
  "switched to",
  "merged",
  "released",
  "turned out",
] as const;

export const SELF_TEST_PHRASES = [
  "harness live test",
  "smoke test alpha",
  "reply with exactly",
  "respond with exactly",
  "answer with exactly",
] as const;

export const EMPTY_MEMORY_PHRASES = [
  "我没有记忆",
  "没有相关记忆",
  "没有历史记录",
  "找不到相关会话",
  "无法访问记忆",
  "未找到相关",
  "i don't have any memory",
  "i have no memory",
  "no previous conversation",
  "no relevant memory",
  "not in my memory",
] as const;

export const BLOCKED_PHRASES = [
  "call blocked",
  "permission denied",
  "not permitted",
  "requires approval",
  "无法继续",
  "无法执行",
  "拒绝访问",
  "权限不足",
  "没有权限",
  "被阻止",
] as const;

export const GAVE_UP_PHRASES = [
  "放弃",
  "不做了",
  "回滚",
  "revert",
  "reverted",
  "gave up",
  "dead end",
  "backed out",
  "rolled back",
  "rolled back",
] as const;

export const PLUMBING_PREFIXES = [
  "ran:",
  "output:",
  "edit:",
  "edited:",
  "read:",
  "write:",
  "wrote:",
  "bash:",
  "tool:",
  "command:",
  "result:",
] as const;

const SMOKE_ASKS = [
  "reply with",
  "respond with",
  "answer with",
  "answer one line",
  "只回复",
  "请回复",
  "回复一个词",
  "回答一个词",
] as const;

export interface RecallMessage {
  ordinal: number;
  ts: string | null;
  role: MessageRole;
  kind: string;
  text: string;
}

export interface RecallCandidate {
  sid: string;
  agent: AgentName;
  project: string | null;
  updatedAt: string | null;
  messages: RecallMessage[];
  current?: boolean;
  lineageSids?: readonly string[];
}

export interface RecallOptions {
  aggressive?: boolean;
  maxBytes?: number;
  maxSessions?: number;
  currentSid?: string;
  excludedSids?: Iterable<string>;
  anchorTerms?: readonly string[];
  anchorNeed?: number;
  nearDuplicateThreshold?: number;
  now?: Date;
}

interface SelectedQuote extends RecallQuote {
  messageIndex: number;
  hits: number;
}

function oneLine(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[-*•]\s+/, "");
}

function nonEmptyLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function includesAny(text: string, phrases: readonly string[]): boolean {
  const low = normalizeText(text);
  return phrases.some((phrase) => low.includes(normalizeText(phrase)));
}

function isPlumbingLine(line: string): boolean {
  const low = normalizeText(line);
  return (
    PLUMBING_PREFIXES.some((prefix) => low.startsWith(prefix)) ||
    low.includes("<tool_use") ||
    low.includes("<tool_result") ||
    low.includes('"type":"tool_use"') ||
    low.includes('"type":"tool_result"') ||
    low.includes("<system-reminder") ||
    low.startsWith("base directory for this skill")
  );
}

function isPlumbingMessage(message: RecallMessage): boolean {
  if (message.role === "tool_call" || message.role === "tool_result") {
    return true;
  }
  const lines = nonEmptyLines(message.text);
  return lines.length === 0 || lines.every(isPlumbingLine);
}

function isSingleBullet(text: string): boolean {
  const lines = nonEmptyLines(text);
  return lines.length === 1 && /^[-*•]\s+\S/.test(lines[0]!);
}

function isStructuralLine(line: string): boolean {
  const trimmed = line.trim();
  return (
    /^#{1,6}\s/.test(trimmed) ||
    trimmed.startsWith("```") ||
    trimmed.startsWith("~~~") ||
    /^\|?\s*:?-{3,}/.test(trimmed) ||
    /^(?:[-*+]|\d+[.)])\s*$/.test(trimmed)
  );
}

function isHarnessSelfTest(messages: readonly RecallMessage[]): boolean {
  // A self-test is the opening purpose of its session. Long multi-topic
  // sessions can contain a harness test deeper in their history without being
  // a harness-test session.
  return messages.slice(0, 8).some(
    (message) =>
      (message.role === "user" || message.role === "assistant") &&
      includesAny(message.text, SELF_TEST_PHRASES),
  );
}

function isNoMemory(text: string): boolean {
  return includesAny(text, EMPTY_MEMORY_PHRASES);
}

function isBlocked(text: string): boolean {
  return includesAny(text, BLOCKED_PHRASES);
}

export function carriesDecision(text: string, queryTerms: readonly string[] = []): boolean {
  const low = normalizeText(text);
  return DECISION_MARKERS.some((marker) => {
    const needle = normalizeText(marker);
    const markerComesFromQuery = queryTerms.some(
      (term) => term.length >= 2 && (term.includes(needle) || needle.includes(term)),
    );
    const present = /[a-z0-9]/i.test(needle) ? carriesTerm(low, needle) : low.includes(needle);
    return !markerComesFromQuery && present;
  });
}

function isSmokeTest(problem: string, conclusions: readonly RecallQuote[]): boolean {
  const low = normalizeText(problem);
  const answerLength = conclusions.reduce((total, quote) => total + [...quote.text].length, 0);
  if (answerLength > 20) {
    return false;
  }
  const sentences = low.split(/[。.!！?？\n]/).map((sentence) => sentence.trim()).filter(Boolean);
  return sentences.some((sentence) =>
    SMOKE_ASKS.some((ask) => sentence.startsWith(normalizeText(ask))),
  );
}

function wasBlocked(conclusions: readonly RecallQuote[]): boolean {
  return conclusions.length > 0 && conclusions.every((quote) => isBlocked(quote.text));
}

function bestMatchingLine(
  text: string,
  terms: readonly string[],
  allowNoMatch = false,
): { text: string; hits: number } | null {
  let best: { text: string; hits: number } | null = null;
  for (const line of nonEmptyLines(text)) {
    if (isPlumbingLine(line) || isNoMemory(line) || isStructuralLine(line)) {
      continue;
    }
    const hits = termHits(line, terms);
    if (hits > 0 && (!best || hits > best.hits)) {
      best = { text: line, hits };
    }
  }
  if (best || !allowNoMatch) {
    return best;
  }
  const first = nonEmptyLines(text).find(
    (line) => !isPlumbingLine(line) && !isNoMemory(line) && !isStructuralLine(line),
  );
  return first ? { text: first, hits: 0 } : null;
}

function bestDecisionLine(
  text: string,
  terms: readonly string[],
  allowNoMatch = true,
): { text: string; hits: number } | null {
  let best: { text: string; hits: number } | null = null;
  for (const line of nonEmptyLines(text)) {
    if (isPlumbingLine(line) || isNoMemory(line) || isStructuralLine(line)) {
      continue;
    }
    if (!carriesDecision(line, terms)) {
      continue;
    }
    const hits = termHits(line, terms);
    if (hits > 0 || allowNoMatch) {
      if (!best || hits > best.hits) {
        best = { text: line, hits };
      }
    }
  }
  return best;
}

function quoteFrom(
  message: RecallMessage,
  text: string,
  hits: number,
  messageIndex: number,
): SelectedQuote {
  return {
    ordinal: message.ordinal,
    role: message.role,
    text: oneLine(text),
    ts: message.ts,
    messageIndex,
    hits,
  };
}

function findProblems(
  messages: readonly RecallMessage[],
  terms: readonly string[],
  limit = 8,
): SelectedQuote[] {
  const problems: SelectedQuote[] = [];
  messages.forEach((message, index) => {
    if (message.role !== "user" || isPlumbingMessage(message) || isNoMemory(message.text)) {
      return;
    }
    const line = bestMatchingLine(message.text, terms);
    if (!line) {
      return;
    }
    problems.push(quoteFrom(message, line.text, line.hits, index));
  });
  return problems
    .sort(
      (left, right) =>
        right.hits - left.hits ||
        right.ordinal - left.ordinal ||
        right.messageIndex - left.messageIndex,
    )
    .slice(0, limit);
}

function findConclusions(
  messages: readonly RecallMessage[],
  problemIndex: number,
  terms: readonly string[],
  limit: number,
): SelectedQuote[] {
  const candidates: SelectedQuote[] = [];
  const start = problemIndex + 1;
  const end = Math.min(messages.length, problemIndex + 1 + REPLY_WINDOW);
  for (let index = start; index < end; index += 1) {
    const message = messages[index]!;
    if (message.role !== "assistant" || isPlumbingMessage(message) || isSingleBullet(message.text)) {
      continue;
    }
    const decision = bestDecisionLine(message.text, terms);
    if (decision) {
      candidates.push(quoteFrom(message, decision.text, decision.hits, index));
    }
  }
  candidates.sort(
    (left, right) => right.hits - left.hits || left.messageIndex - right.messageIndex,
  );
  if (candidates.length === 0) {
    // Real sessions often answer without saying "decision:" or "fixed:". Use
    // the strongest on-topic assistant line inside the same reply window as
    // the conclusion slot rather than dropping an otherwise valid memory.
    for (let index = start; index < end; index += 1) {
      const message = messages[index]!;
      if (
        message.role !== "assistant" ||
        isPlumbingMessage(message) ||
        isSingleBullet(message.text)
      ) {
        continue;
      }
      const line = bestMatchingLine(message.text, terms);
      if (!line || line.hits === 0) {
        continue;
      }
      candidates.push(quoteFrom(message, line.text, line.hits, index));
    }
  }
  return candidates.slice(0, limit).sort((left, right) => left.ordinal - right.ordinal);
}

function collectEvidence(
  messages: readonly RecallMessage[],
  problemIndex: number,
  terms: readonly string[],
  selected: readonly SelectedQuote[],
): RecallQuote[] {
  const selectedKeys = new Set(selected.map((quote) => `${quote.messageIndex}:${quote.text}`));
  const evidence: SelectedQuote[] = [];
  const end = Math.min(messages.length, problemIndex + 1 + REPLY_WINDOW);
  for (let index = problemIndex + 1; index < end; index += 1) {
    const message = messages[index]!;
    if (message.role === "tool_call" || message.role === "tool_result" || isPlumbingMessage(message)) {
      continue;
    }
    if (message.role !== "assistant") {
      continue;
    }
    const line = bestMatchingLine(message.text, terms);
    if (!line || line.hits === 0 || selectedKeys.has(`${index}:${oneLine(line.text)}`)) {
      continue;
    }
    if (isNoMemory(line.text) || isSingleBullet(line.text)) {
      continue;
    }
    evidence.push(quoteFrom(message, line.text, line.hits, index));
  }
  return dedupeQuotes(evidence)
    .sort((left, right) => left.ordinal - right.ordinal)
    .slice(0, 3)
    .map(({ messageIndex: _messageIndex, hits: _hits, ...quote }) => quote);
}

function quoteFingerprint(text: string): Set<string> {
  return new Set(tokenize(text));
}

function nearDuplicate(
  candidate: readonly RecallMessage[],
  prior: readonly RecallMessage[][],
  threshold: number,
): boolean {
  const words = new Set<string>();
  for (const message of candidate) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }
    for (const token of tokenize(message.text)) {
      words.add(token);
    }
  }
  if (words.size === 0) {
    return false;
  }
  for (const previous of prior) {
    const previousWords = new Set<string>();
    for (const message of previous) {
      if (message.role !== "user" && message.role !== "assistant") {
        continue;
      }
      for (const token of tokenize(message.text)) {
        previousWords.add(token);
      }
    }
    let intersection = 0;
    for (const word of words) {
      if (previousWords.has(word)) {
        intersection += 1;
      }
    }
    const union = words.size + previousWords.size - intersection;
    if (union > 0 && intersection / union >= threshold) {
      return true;
    }
  }
  return false;
}

function dedupeQuotes(quotes: readonly SelectedQuote[]): SelectedQuote[] {
  const kept: SelectedQuote[] = [];
  for (const quote of quotes) {
    const fingerprint = quoteFingerprint(quote.text);
    const duplicate = kept.some((existing) => {
      if (normalizeText(existing.text) === normalizeText(quote.text)) {
        return true;
      }
      const other = quoteFingerprint(existing.text);
      let intersection = 0;
      for (const token of fingerprint) {
        if (other.has(token)) {
          intersection += 1;
        }
      }
      const union = fingerprint.size + other.size - intersection;
      return union > 0 && intersection / union >= 0.8;
    });
    if (!duplicate) {
      kept.push(quote);
    }
  }
  return kept;
}

function truncateChars(text: string, maxChars: number): string {
  const chars = [...text];
  if (chars.length <= maxChars) {
    return text;
  }
  if (maxChars <= 1) {
    return "…";
  }
  return `${chars.slice(0, maxChars - 1).join("").trimEnd()}…`;
}

function fitConclusions(quotes: readonly SelectedQuote[], budget: number): RecallQuote[] {
  const fitted: RecallQuote[] = [];
  let spent = 0;
  for (const quote of quotes) {
    const remaining = budget - spent;
    if (remaining <= 1) {
      break;
    }
    const text = truncateChars(quote.text, remaining);
    fitted.push({ ordinal: quote.ordinal, role: quote.role, text, ts: quote.ts });
    spent += [...text].length;
  }
  return fitted;
}

export function conclusionPolicy(candidateCount: number): { budget: number; limit: number } {
  if (candidateCount <= 1) {
    return CONCLUSION_POLICY.one;
  }
  if (candidateCount === 2) {
    return CONCLUSION_POLICY.two;
  }
  return CONCLUSION_POLICY.many;
}

function dateOnly(timestamp: string | null): string {
  if (!timestamp) {
    return "";
  }
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? "" : new Date(parsed).toISOString().slice(0, 10);
}

function blockTimestamp(block: RecallBlock): string | null {
  const conclusionStamps = block.conclusion
    .map((quote) => quote.ts)
    .filter((ts): ts is string => ts !== null);
  if (conclusionStamps.length > 0) {
    return conclusionStamps.sort().at(-1) ?? null;
  }
  return block.problem?.ts ?? block.updatedAt;
}

export function formatRecallBlock(block: RecallBlock): string {
  const timestamp = blockTimestamp(block);
  const lines = [
    `✓ 历史参考 · 来自 ${block.agent} 会话${timestamp ? ` · ${dateOnly(timestamp)}` : ""}`,
    `  - Session: **${oneLine(block.project ?? "unknown")}** \`${block.sid}\``,
  ];
  if (block.problem) {
    lines.push(`  - 问题: ${oneLine(block.problem.text)}`);
  }
  const conclusionSet = new Set(block.conclusion);
  const details = [...block.evidence, ...block.conclusion].sort(
    (left, right) => left.ordinal - right.ordinal,
  );
  for (const detail of details) {
    const label = conclusionSet.has(detail) ? "结论" : "证据";
    lines.push(`  - ${label}: ${oneLine(detail.text)}`);
  }
  return lines.join("\n");
}

export function formatRecall(blocks: readonly RecallBlock[]): string {
  const body = blocks.map(formatRecallBlock).join("\n\n").trim();
  if (!body) {
    return "";
  }
  return `${body}\n\n  - 注: 历史参考，不是当前事实；引用前请用当前工具核对。`;
}

function removeEvidenceToFit(blocks: RecallBlock[], maxBytes: number): void {
  for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
    while (
      blocks[blockIndex]!.evidence.length > 0 &&
      Buffer.byteLength(formatRecall(blocks), "utf8") > maxBytes
    ) {
      blocks[blockIndex]!.evidence.pop();
    }
    if (Buffer.byteLength(formatRecall(blocks), "utf8") <= maxBytes) {
      return;
    }
  }
}

function trimConclusionsToFit(blocks: RecallBlock[], maxBytes: number): void {
  while (Buffer.byteLength(formatRecall(blocks), "utf8") > maxBytes) {
    let changed = false;
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex]!;
      for (let quoteIndex = block.conclusion.length - 1; quoteIndex >= 0; quoteIndex -= 1) {
        const quote = block.conclusion[quoteIndex]!;
        const excess = Buffer.byteLength(formatRecall(blocks), "utf8") - maxBytes;
        if (excess <= 0) {
          return;
        }
        const chars = [...quote.text];
        if (chars.length > 2) {
          const remove = Math.max(1, Math.ceil(excess / 3));
          block.conclusion[quoteIndex] = {
            ...quote,
            text: truncateChars(quote.text, Math.max(2, chars.length - remove)),
          };
          changed = true;
        }
      }
    }
    if (!changed) {
      if (blocks.length > 1) {
        blocks.pop();
        continue;
      }
      break;
    }
  }
}

export function buildRecall(
  query: string,
  candidates: readonly RecallCandidate[],
  options: RecallOptions = {},
): RecallBlock[] {
  const terms = tokenize(query);
  if (terms.length === 0 || candidates.length === 0) {
    return [];
  }

  const excluded = new Set<string>(options.excludedSids ?? []);
  if (options.currentSid) {
    excluded.add(options.currentSid);
  }
  const maxSessions = Math.max(
    1,
    options.maxSessions ?? (options.aggressive ? 6 : 3),
  );
  const maxBytes = options.maxBytes ?? (options.aggressive ? 4_096 : 2_048);
  const duplicateThreshold = options.nearDuplicateThreshold ?? 0.8;
  const policy = conclusionPolicy(candidates.length);
  const acceptedMessages: RecallMessage[][] = [];
  const blocks: RecallBlock[] = [];

  for (const candidate of candidates) {
    if (blocks.length >= maxSessions) {
      break;
    }
    if (
      candidate.current ||
      excluded.has(candidate.sid) ||
      (candidate.lineageSids ?? []).some((sid) => excluded.has(sid)) ||
      isHarnessSelfTest(candidate.messages) ||
      nearDuplicate(candidate.messages, acceptedMessages, duplicateThreshold)
    ) {
      continue;
    }

    // Tool records are retained in the index but do not consume the
    // user/assistant reply window.
    const conversation = candidate.messages.filter(
      (message) => message.role === "user" || message.role === "assistant",
    );
    const anchors = options.anchorTerms ?? [];
    const anchorNeed = Math.max(1, options.anchorNeed ?? anchors.length);
    let problem: SelectedQuote | null = null;
    let conclusions: SelectedQuote[] = [];
    let fittedConclusions: RecallQuote[] = [];
    for (const possible of findProblems(conversation, terms)) {
      if (
        anchors.length > 0 &&
        termHits(conversation[possible.messageIndex]!.text, anchors) <
          Math.min(anchorNeed, anchors.length)
      ) {
        continue;
      }
      const possibleConclusions = findConclusions(
        conversation,
        possible.messageIndex,
        terms,
        policy.limit,
      );
      if (possibleConclusions.length === 0) {
        continue;
      }
      const possibleFitted = fitConclusions(
        dedupeQuotes(possibleConclusions),
        policy.budget,
      );
      if (
        possibleFitted.length === 0 ||
        isSmokeTest(possible.text, possibleFitted) ||
        wasBlocked(possibleFitted)
      ) {
        continue;
      }
      problem = possible;
      conclusions = possibleConclusions;
      fittedConclusions = possibleFitted;
      break;
    }
    if (!problem) {
      continue;
    }

    const evidence = collectEvidence(
      conversation,
      problem.messageIndex,
      terms,
      conclusions,
    );
    blocks.push({
      sid: candidate.sid,
      agent: candidate.agent,
      project: candidate.project,
      updatedAt: candidate.updatedAt,
      problem: {
        ordinal: problem.ordinal,
        role: problem.role,
        text: truncateChars(problem.text, 160),
        ts: problem.ts,
      },
      conclusion: fittedConclusions,
      evidence,
    });
    acceptedMessages.push(candidate.messages);
  }

  removeEvidenceToFit(blocks, maxBytes);
  trimConclusionsToFit(blocks, maxBytes);
  return blocks;
}
