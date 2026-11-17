export type PiRole = "user" | "assistant" | "tool_call" | "tool_result";

export interface PiMessage {
  sid: string;
  ordinal: number;
  timestamp: string | null;
  role: PiRole;
  kind: string;
  text: string;
  cwd: string | null;
}

export interface PiSessionMeta {
  sid: string;
  timestamp: string | null;
  cwd: string | null;
}

export type PiEvent =
  | { type: "session"; value: PiSessionMeta }
  | { type: "message"; value: PiMessage };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textBlocks(content: unknown): string[] {
  if (typeof content === "string") {
    return [content];
  }
  if (!Array.isArray(content)) {
    return [];
  }
  const parts: string[] = [];
  for (const item of content) {
    const block = object(item);
    if (block && string(block.type) === "text") {
      const text = string(block.text);
      if (text) {
        parts.push(text);
      }
    }
  }
  return parts;
}

function renderToolCall(block: JsonObject): string {
  const name = string(block.name) ?? "tool";
  const raw = block.arguments;
  let rendered = raw === undefined ? "" : String(raw);
  if (typeof raw === "string") {
    try {
      rendered = JSON.stringify(JSON.parse(raw));
    } catch {
      rendered = raw;
    }
  } else if (raw !== undefined) {
    rendered = JSON.stringify(raw);
  }
  return `${name}: ${rendered}`;
}

export function parsePiLine(
  line: string,
  fallbackSid = "",
  fallbackOrdinal = 0,
): PiEvent | null {
  if (line.length > 2_000_000) {
    return null;
  }
  if (!/"type"\s*:\s*"(?:session|message)"/.test(line)) {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }

  const root = object(value);
  if (!root) {
    return null;
  }

  if (root.type === "session") {
    const sid = string(root.id) ?? fallbackSid;
    if (!sid) {
      return null;
    }
    return {
      type: "session",
      value: {
        sid,
        timestamp: string(root.timestamp),
        cwd: string(root.cwd),
      },
    };
  }

  if (root.type !== "message") {
    return null;
  }
  const message = object(root.message);
  if (!message) {
    return null;
  }
  const role = string(message.role);
  const timestamp = string(root.timestamp) ?? string(message.timestamp);
  const ordinal =
    typeof root.ordinal === "number" ? root.ordinal : fallbackOrdinal;

  if (role === "user") {
    const text = textBlocks(message.content).join("\n").trim();
    if (!text) {
      return null;
    }
    return {
      type: "message",
      value: {
        sid: fallbackSid,
        ordinal,
        timestamp,
        role: "user",
        kind: "text",
        text,
        cwd: null,
      },
    };
  }

  if (role === "assistant") {
    const content = Array.isArray(message.content) ? message.content : [];
    const parts: string[] = [];
    let hasToolCall = false;
    for (const item of content) {
      const block = object(item);
      if (!block) {
        continue;
      }
      const type = string(block.type);
      if (type === "text") {
        const text = string(block.text);
        if (text) {
          parts.push(text);
        }
      } else if (type === "toolCall") {
        hasToolCall = true;
        parts.push(renderToolCall(block));
      }
    }
    const text = parts.join("\n").trim();
    if (!text) {
      return null;
    }
    return {
      type: "message",
      value: {
        sid: fallbackSid,
        ordinal,
        timestamp,
        role: hasToolCall ? "tool_call" : "assistant",
        kind: hasToolCall ? "tool_call" : "assistant_text",
        text,
        cwd: null,
      },
    };
  }

  if (role === "toolResult") {
    const text = textBlocks(message.content).join("\n").trim();
    if (!text) {
      return null;
    }
    const toolName = string(message.toolName);
    return {
      type: "message",
      value: {
        sid: fallbackSid,
        ordinal,
        timestamp,
        role: "tool_result",
        kind: toolName ?? "tool_result",
        text,
        cwd: null,
      },
    };
  }

  return null;
}
