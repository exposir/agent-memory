import { readFileSync } from "node:fs";

import * as zlib from "node:zlib";

export type DshRole = "user" | "assistant" | "tool_call" | "tool_result";

export interface DshMessage {
  ordinal: number;
  timestamp: string | null;
  role: DshRole;
  kind: string;
  text: string;
}

export interface DshSession {
  sid: string;
  cwd: string | null;
  startedAt: string | null;
  messages: DshMessage[];
}

type JsonObject = Record<string, unknown>;

const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MESSAGE_TYPES = new Set([
  "user/message",
  "assistant/message",
  "tool/call",
  "tool/result",
]);

const zstd = zlib as unknown as {
  zstdDecompressSync?: (buffer: Buffer) => Buffer;
};

export function zstdAvailable(): boolean {
  return typeof zstd.zstdDecompressSync === "function";
}

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function string(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function textBlocks(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
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
    }
  }
  return parts.join("\n");
}

function isoTime(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return string(value);
}

interface RawEvent {
  type: string;
  seq: number | null;
  time: string | null;
  data: JsonObject;
  order: number;
}

function decodeFrames(buffer: Buffer): RawEvent[] {
  const events: RawEvent[] = [];
  const seen = new Set<string>();
  let offset = buffer.indexOf(FRAME_MAGIC, 0);
  while (offset !== -1) {
    let text: string | null = null;
    try {
      text = zstd.zstdDecompressSync!(buffer.subarray(offset)).toString("utf8");
    } catch {
      text = null;
    }
    if (text) {
      for (const line of text.split("\n")) {
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
        const type = string(root.type);
        const data = object(root.data);
        if (!type || !data || !MESSAGE_TYPES.has(type)) {
          continue;
        }
        const seq = typeof root.seq === "number" ? root.seq : null;
        const key = seq === null ? null : `${type}:${seq}`;
        if (key !== null && seen.has(key)) {
          continue;
        }
        if (key !== null) {
          seen.add(key);
        }
        events.push({
          type,
          seq,
          time: isoTime(root.time),
          data,
          order: events.length,
        });
      }
    }
    offset = buffer.indexOf(FRAME_MAGIC, offset + 4);
  }
  return events;
}

function eventMessage(event: RawEvent, ordinal: number): DshMessage | null {
  const { data } = event;
  if (event.type === "user/message") {
    const text = textBlocks(data.content).trim();
    if (!text) {
      return null;
    }
    return { ordinal, timestamp: event.time, role: "user", kind: event.type, text };
  }

  if (event.type === "assistant/message") {
    const message = object(data.message);
    const text = message ? textBlocks(message.content).trim() : "";
    if (!text) {
      return null;
    }
    return { ordinal, timestamp: event.time, role: "assistant", kind: event.type, text };
  }

  if (event.type === "tool/call") {
    const name = string(data.name) ?? "tool";
    const raw = data.arguments;
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
    const text = `${name}: ${rendered}`.trim();
    if (!text) {
      return null;
    }
    return { ordinal, timestamp: event.time, role: "tool_call", kind: name, text };
  }

  const message = object(data.message);
  const text = message ? textBlocks(message.content).trim() : "";
  if (!text) {
    return null;
  }
  return { ordinal, timestamp: event.time, role: "tool_result", kind: event.type, text };
}

export function readDshSession(path: string, fallbackSid: string): DshSession {
  if (!zstdAvailable()) {
    throw new Error("dsh 解析需要 Node >= 22.15（zlib.zstdDecompressSync）");
  }
  const events = decodeFrames(readFileSync(path));
  events.sort((left, right) => {
    const leftSeq = left.seq ?? Number.MAX_SAFE_INTEGER;
    const rightSeq = right.seq ?? Number.MAX_SAFE_INTEGER;
    return leftSeq === rightSeq ? left.order - right.order : leftSeq - rightSeq;
  });

  const messages: DshMessage[] = [];
  for (const event of events) {
    const message = eventMessage(event, messages.length);
    if (message) {
      messages.push(message);
    }
  }

  let cwd: string | null = null;
  for (const event of events) {
    const meta = object(event.data.meta);
    const candidate = meta ? string(meta.cwd) : null;
    if (candidate) {
      cwd = candidate;
      break;
    }
  }

  return {
    sid: fallbackSid,
    cwd,
    startedAt: messages[0]?.timestamp ?? null,
    messages,
  };
}
