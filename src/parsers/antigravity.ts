import { readFileSync } from "node:fs";

export type AntigravityRole = "user" | "assistant" | "tool_call" | "tool_result" | "compaction";

export interface AntigravityMessage {
  ordinal: number;
  timestamp: string | null;
  role: AntigravityRole;
  kind: string;
  text: string;
}

export interface AntigravitySession {
  sid: string;
  cwd: string | null;
  startedAt: string | null;
  messages: AntigravityMessage[];
}

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function userPrompt(content: string): string {
  const match = content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
  return (match ? match[1]! : content).trim();
}

function renderToolCall(call: JsonObject): string {
  const name = string(call.name) ?? "tool";
  const args = call.args;
  const rendered =
    args === undefined
      ? ""
      : typeof args === "string"
        ? args
        : JSON.stringify(args);
  return `${name}: ${rendered}`;
}

function lineMessage(root: JsonObject, ordinal: number): AntigravityMessage | null {
  const type = string(root.type);
  const timestamp = string(root.created_at);
  if (!type) {
    return null;
  }

  if (type === "USER_INPUT") {
    const content = string(root.content);
    const text = content ? userPrompt(content) : "";
    if (!text) {
      return null;
    }
    return { ordinal, timestamp, role: "user", kind: type, text };
  }

  if (type === "PLANNER_RESPONSE") {
    const parts: string[] = [];
    const content = string(root.content);
    if (content && content.trim()) {
      parts.push(content.trim());
    }
    const calls = Array.isArray(root.tool_calls) ? root.tool_calls : [];
    let hasCalls = false;
    for (const item of calls) {
      const call = object(item);
      if (call) {
        hasCalls = true;
        parts.push(renderToolCall(call));
      }
    }
    const text = parts.join("\n").trim();
    if (!text) {
      return null;
    }
    return {
      ordinal,
      timestamp,
      role: hasCalls ? "tool_call" : "assistant",
      kind: hasCalls ? "tool_call" : "assistant_text",
      text,
    };
  }

  if (type === "GENERIC") {
    const text = (string(root.content) ?? "").trim();
    if (!text) {
      return null;
    }
    return { ordinal, timestamp, role: "tool_result", kind: type, text };
  }

  if (type === "CHECKPOINT") {
    const text = (string(root.content) ?? "").trim();
    if (!text) {
      return null;
    }
    return { ordinal, timestamp, role: "compaction", kind: type, text };
  }

  return null;
}

export function readAntigravityTranscript(path: string, sid: string): AntigravitySession {
  const messages: AntigravityMessage[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const root = object(value);
    if (!root) {
      continue;
    }
    const message = lineMessage(root, messages.length);
    if (message) {
      messages.push(message);
    }
  }
  return {
    sid,
    cwd: null,
    startedAt: messages[0]?.timestamp ?? null,
    messages,
  };
}
