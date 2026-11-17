export type ClaudeRole = "user" | "assistant" | "tool_call" | "tool_result";

export interface ClaudeMessage {
  sid: string;
  ordinal: number;
  timestamp: string | null;
  role: ClaudeRole;
  kind: string;
  text: string;
  cwd: string | null;
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

function blockText(content: unknown, role: ClaudeRole): { kind: string; text: string } | null {
  if (typeof content === "string") {
    return { kind: "text", text: content };
  }
  if (!Array.isArray(content)) {
    return null;
  }

  const parts: string[] = [];
  let kind = role === "user" ? "text" : "assistant_text";
  for (const value of content) {
    const block = object(value);
    if (!block) {
      continue;
    }
    const type = string(block.type);
    if (type === "text") {
      const text = string(block.text);
      if (text) {
        parts.push(text);
      }
    } else if (type === "tool_use") {
      kind = "tool_call";
      const name = string(block.name) ?? "tool";
      const input = block.input;
      parts.push(`${name}: ${input === undefined ? "" : JSON.stringify(input)}`);
    } else if (type === "tool_result") {
      kind = "tool_result";
      const nested = block.content;
      if (typeof nested === "string") {
        parts.push(nested);
      } else if (Array.isArray(nested)) {
        for (const nestedValue of nested) {
          const nestedBlock = object(nestedValue);
          const text = nestedBlock ? string(nestedBlock.text) : null;
          if (text) {
            parts.push(text);
          }
        }
      }
    }
  }

  const text = parts.join("\n").trim();
  return text ? { kind, text } : null;
}

export function parseClaudeLine(
  line: string,
  sid: string,
  ordinal: number,
  project: string,
): ClaudeMessage | null {
  if (line.length > 2_000_000) {
    return null;
  }
  if (!/"type"\s*:\s*"(?:user|assistant)"/.test(line)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  const root = object(value);
  if (!root || (root.type !== "user" && root.type !== "assistant") || root.isSidechain === true) {
    return null;
  }

  const message = object(root.message);
  if (!message) {
    return null;
  }
  const role = root.type as "user" | "assistant";
  const parsed = blockText(message.content, root.type === "user" ? "user" : "assistant");
  if (!parsed) {
    return null;
  }

  return {
    sid,
    ordinal,
    timestamp: string(root.timestamp),
    role: parsed.kind === "tool_call" || parsed.kind === "tool_result" ? parsed.kind : role,
    kind: parsed.kind,
    text: parsed.text,
    cwd: string(root.cwd) ?? project,
  };
}
