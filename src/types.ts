export const AGENT_NAMES = [
  "claude",
  "codex",
  "opencode",
  "qoder",
  "pi",
  "dsh",
  "antigravity",
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const MESSAGE_ROLES = [
  "user",
  "assistant",
  "tool_call",
  "tool_result",
  "compaction",
] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

export interface Session {
  id: string;
  agent: AgentName;
  project: string | null;
  cwd: string | null;
  title: string | null;
  path: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  settled: boolean;
  gaveUp: boolean;
  pasted: boolean;
  words: number;
  sidechain: boolean;
}

export interface Message {
  id: number | null;
  sid: string;
  ordinal: number;
  ts: string | null;
  role: MessageRole;
  kind: string;
  text: string;
  meta: string | null;
}

export interface FileState {
  path: string;
  agent: AgentName;
  size: number;
  mtimeNs: bigint;
  offset: number;
  lineNo: number;
  prefixSample: Uint8Array;
  sid: string | null;
}

export interface Note {
  id: string;
  scope: "global" | "repo";
  project: string | null;
  kind: string;
  text: string;
  state: "active" | "archived" | "superseded";
  created: string | null;
  source: string | null;
  supersedes: string | null;
  writtenBy: string | null;
  supersededAt: string | null;
}

export interface SearchHit {
  sid: string;
  agent: AgentName;
  project: string | null;
  title: string | null;
  updatedAt: string | null;
  score: number;
  matched: number;
  strong: number;
  naming: number;
}

export interface RecallQuote {
  ordinal: number;
  role: MessageRole;
  text: string;
  ts: string | null;
}

export interface RecallBlock {
  sid: string;
  agent: AgentName;
  project: string | null;
  updatedAt: string | null;
  problem: RecallQuote | null;
  conclusion: RecallQuote[];
  evidence: RecallQuote[];
}
