import Database from "better-sqlite3";

import type { MessageRole } from "../types.js";

export interface OpencodeMessage {
  ordinal: number;
  timestamp: string | null;
  role: MessageRole;
  kind: string;
  text: string;
}

export interface OpencodeSession {
  sid: string;
  title: string | null;
  project: string;
  startedAt: string | null;
  updatedAt: string | null;
  messages: OpencodeMessage[];
}

interface SessionRow {
  id: string;
  title: string | null;
  directory: string;
  time_created: number;
  time_updated: number;
}

interface MessageRow {
  session_id: string;
  type: string;
  seq: number;
  time_created: number;
  data: string;
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) {
        return "";
      }
      const block = part as Record<string, unknown>;
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

function parseMessage(row: MessageRow): OpencodeMessage | null {
  if (row.type !== "user" && row.type !== "assistant") {
    return null;
  }
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(row.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text =
    row.type === "user" && typeof data.text === "string"
      ? data.text
      : row.type === "assistant"
        ? textFromContent(data.content)
        : "";
  if (!text.trim()) {
    return null;
  }
  return {
    ordinal: row.seq,
    timestamp: new Date(row.time_created).toISOString(),
    role: row.type,
    kind: row.type === "user" ? "UserMessage" : "AgentMessage",
    text,
  };
}

export function readOpencodeSessions(path: string): OpencodeSession[] {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  const sessions = db
    .prepare(
      `SELECT id, title, directory, time_created, time_updated
       FROM session_v2
       ORDER BY time_created, id`,
    )
    .all() as SessionRow[];
  const messageReader = db.prepare(
    `SELECT session_id, type, seq, time_created, data
     FROM session_message
     WHERE session_id = ?
     ORDER BY seq, time_created, id`,
  );

  const output = sessions.map((session) => ({
    sid: session.id,
    title: session.title,
    project: session.directory,
    startedAt: new Date(session.time_created).toISOString(),
    updatedAt: new Date(session.time_updated).toISOString(),
    messages: (messageReader.all(session.id) as MessageRow[])
      .map(parseMessage)
      .filter((message): message is OpencodeMessage => message !== null),
  }));
  db.close();
  return output;
}
