export type CodexRole = "user" | "assistant" | "tool_call" | "tool_result";

export interface CodexMessage {
  sid: string;
  ordinal: number;
  timestamp: string | null;
  role: CodexRole;
  kind: string;
  text: string;
  cwd: string | null;
}

export interface CodexSessionMeta {
  sid: string;
  timestamp: string | null;
  cwd: string | null;
  model: string | null;
}

export type CodexEvent =
  | { type: "session"; value: CodexSessionMeta }
  | { type: "message"; value: CodexMessage };

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const parts: string[] = [];
  for (const item of content) {
    if (typeof item === "string") {
      parts.push(item);
      continue;
    }
    const block = object(item);
    if (!block) {
      continue;
    }
    // Modern rollouts use lowercase "text"; older fixtures used "Text".
    const type = string(block.type)?.toLowerCase();
    const text = string(block.text);
    if (text && (type === "text" || type === "input_text" || type === "output_text")) {
      parts.push(text);
    }
  }
  return parts.join("\n");
}

function commandText(item: JsonObject): string {
  const command = item.command;
  let rendered = "";
  if (Array.isArray(command)) {
    rendered = command.map(String).join(" ");
  } else {
    rendered = string(command) ?? "";
  }
  const output = string(item.aggregated_output) ?? "";
  return [rendered, output].filter(Boolean).join("\n");
}

function fileChangeText(item: JsonObject): string {
  const changes = item.changes;
  if (!Array.isArray(changes)) {
    return "";
  }
  return changes
    .map((change) => {
      const block = object(change);
      return block ? string(block.path) : null;
    })
    .filter((path): path is string => Boolean(path))
    .join("\n");
}

export function parseCodexLine(
  line: string,
  fallbackSid = "",
  fallbackOrdinal = 0,
): CodexEvent | null {
  if (line.length > 2_000_000) {
    return null;
  }
  if (!/"type"\s*:\s*"(?:session_meta|event_msg)"/.test(line)) {
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
  const payload = object(root.payload);
  if (!payload) {
    return null;
  }

  if (root.type === "session_meta") {
    const sid = string(payload.id) ?? string(payload.session_id) ?? fallbackSid;
    if (!sid) {
      return null;
    }
    const modelInfo = object(payload.model_info);
    return {
      type: "session",
      value: {
        sid,
        timestamp: string(root.timestamp) ?? string(payload.timestamp),
        cwd: string(payload.cwd),
        model:
          string(payload.model) ??
          string(payload.model_name) ??
          (modelInfo ? string(modelInfo.slug) ?? string(modelInfo.name) : null),
      },
    };
  }

  const ordinal = typeof root.ordinal === "number" ? root.ordinal : fallbackOrdinal;
  const timestamp = string(root.timestamp);
  const cwd = string(payload.cwd);

  if (root.type === "event_msg" && payload.type === "item_completed") {
    const item = object(payload.item);
    if (!item) {
      return null;
    }
    const kind = string(item.type);
    if (!kind) {
      return null;
    }

    if (kind === "UserMessage" || kind === "AgentMessage") {
      const text = contentText(item.content);
      if (!text.trim()) {
        return null;
      }
      return {
        type: "message",
        value: {
          sid: fallbackSid,
          ordinal,
          timestamp,
          role: kind === "UserMessage" ? "user" : "assistant",
          kind,
          text,
          cwd,
        },
      };
    }

    if (kind === "CommandExecution" || kind === "McpToolCall") {
      const text = commandText(item).trim();
      if (!text) {
        return null;
      }
      return {
        type: "message",
        value: {
          sid: fallbackSid,
          ordinal,
          timestamp,
          role: "tool_call",
          kind,
          text,
          cwd,
        },
      };
    }

    if (kind === "FileChange") {
      const text = fileChangeText(item).trim();
      if (!text) {
        return null;
      }
      return {
        type: "message",
        value: {
          sid: fallbackSid,
          ordinal,
          timestamp,
          role: "tool_result",
          kind,
          text,
          cwd,
        },
      };
    }
  }

  // Some older rollouts used payload.type="user_message" rather than
  // item_completed + item.type="UserMessage".
  if (root.type === "event_msg" && payload.type === "user_message") {
    const text = contentText(payload.content) || string(payload.message) || "";
    if (!text.trim()) {
      return null;
    }
    return {
      type: "message",
      value: {
        sid: fallbackSid,
        ordinal,
        timestamp,
        role: "user",
        kind: "UserMessage",
        text,
        cwd,
      },
    };
  }

  return null;
}
