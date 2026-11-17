import type Database from "better-sqlite3";

import { addMessage } from "./db.js";
import { tokenize } from "./tokenize.js";
import type { MessageRole } from "./types.js";

export interface ParsedMessage {
  sid: string;
  ordinal: number;
  timestamp: string | null;
  role: MessageRole;
  kind: string;
  text: string;
  cwd: string | null;
  meta?: string | null;
}

interface IndexStatements {
  deleteFts: Database.Statement<[number]>;
  insertFts: Database.Statement<[number, string, string]>;
  upsertTerm: Database.Statement<[string, string, number, number]>;
}

const STATEMENTS = new WeakMap<Database.Database, IndexStatements>();

function statementsFor(db: Database.Database): IndexStatements {
  let statements = STATEMENTS.get(db);
  if (!statements) {
    statements = {
      deleteFts: db.prepare("DELETE FROM msgs_fts WHERE rowid = ?"),
      insertFts: db.prepare(
        "INSERT INTO msgs_fts(rowid, tokens, utokens) VALUES (?, ?, ?)",
      ),
      upsertTerm: db.prepare(
        `INSERT INTO session_terms(term, sid, tf, user_tf)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(term, sid) DO UPDATE SET
           tf = session_terms.tf + excluded.tf,
           user_tf = session_terms.user_tf + excluded.user_tf`,
      ),
    };
    STATEMENTS.set(db, statements);
  }
  return statements;
}

function indexTokens(
  db: Database.Database,
  id: number,
  message: ParsedMessage,
): void {
  const tokens = tokenize(message.text);
  const unique = [...new Set(tokens)];
  const statements = statementsFor(db);
  statements.deleteFts.run(id);
  statements.insertFts.run(id, tokens.join(" "), unique.join(" "));
  const counts = new Map<string, number>();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const [term, tf] of counts) {
    statements.upsertTerm.run(term, message.sid, tf, message.role === "user" ? tf : 0);
  }
}

export function insertMessage(db: Database.Database, message: ParsedMessage): number {
  const id = addMessage(db, {
    sid: message.sid,
    ordinal: message.ordinal,
    ts: message.timestamp,
    role: message.role,
    kind: message.kind,
    text: message.text,
    meta: message.meta ?? null,
  });
  indexTokens(db, id, message);
  return id;
}

export function insertMessageWithId(
  db: Database.Database,
  message: ParsedMessage,
  id: number,
): void {
  db.prepare(
    `INSERT INTO msgs(id, sid, ordinal, ts, role, kind, text, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    message.sid,
    message.ordinal,
    message.timestamp,
    message.role,
    message.kind,
    message.text,
    message.meta ?? null,
  );
  indexTokens(db, id, message);
}
