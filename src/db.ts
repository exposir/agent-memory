import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import type { FileState, Message, MessageRole, Note, Session } from "./types.js";
import { tokenize } from "./tokenize.js";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  project TEXT,
  cwd TEXT,
  title TEXT,
  path TEXT,
  started_at TEXT,
  updated_at TEXT,
  settled INTEGER NOT NULL DEFAULT 0,
  gave_up INTEGER NOT NULL DEFAULT 0,
  pasted INTEGER NOT NULL DEFAULT 0,
  words INTEGER NOT NULL DEFAULT 0,
  sidechain INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS sessions_updated ON sessions(updated_at);
CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project);

CREATE TABLE IF NOT EXISTS msgs (
  id INTEGER PRIMARY KEY,
  sid TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  ts TEXT,
  role TEXT NOT NULL CHECK(role IN ('user','assistant','tool_call','tool_result','compaction')),
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  meta TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS msgs_sid_ordinal ON msgs(sid, ordinal);
CREATE INDEX IF NOT EXISTS msgs_sid ON msgs(sid);
CREATE INDEX IF NOT EXISTS msgs_role ON msgs(role);

CREATE VIRTUAL TABLE IF NOT EXISTS msgs_fts USING fts5(
  tokens,
  utokens,
  tokenize = 'unicode61'
);
CREATE VIRTUAL TABLE IF NOT EXISTS msgs_vocab USING fts5vocab(msgs_fts, row);

CREATE TABLE IF NOT EXISTS session_terms (
  term TEXT NOT NULL,
  sid TEXT NOT NULL,
  tf INTEGER NOT NULL,
  user_tf INTEGER NOT NULL,
  PRIMARY KEY (term, sid)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_terms_sid ON session_terms(sid);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime_ns INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  line_no INTEGER NOT NULL,
  prefix_sample BLOB NOT NULL,
  sid TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK(scope IN ('global','repo')),
  project TEXT,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
                CHECK(state IN ('active','archived','superseded')),
  created TEXT,
  source TEXT,
  supersedes TEXT,
  written_by TEXT,
  superseded_at TEXT
);
CREATE INDEX IF NOT EXISTS notes_project ON notes(project);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  tokens,
  tokenize = 'unicode61'
);

CREATE TABLE IF NOT EXISTS recalls (
  sid TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS recalls_at ON recalls(at);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function databasePath(): string {
  if (process.env.MEM_DB) {
    return resolve(process.env.MEM_DB.replace(/^~(?=$|\/)/, homedir()));
  }
  const cache = process.env.XDG_CACHE_HOME
    ? resolve(process.env.XDG_CACHE_HOME)
    : resolve(homedir(), ".cache");
  return resolve(cache, "mem", "mem.db");
}

export function createSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // Existing indexes were built before notes could be corrected. Add the
  // columns in place rather than requiring a rebuild of a multi-GB database.
  const noteColumns = new Set(
    (db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  for (const [name, definition] of [
    ["supersedes", "TEXT"],
    ["written_by", "TEXT"],
    ["superseded_at", "TEXT"],
  ] as const) {
    if (!noteColumns.has(name)) {
      db.exec(`ALTER TABLE notes ADD COLUMN ${name} ${definition}`);
    }
  }
}

export function openDatabase(path = databasePath()): Database.Database {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  createSchema(db);
  return db;
}

export function openReadDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true });
  db.pragma("query_only = ON");
  return db;
}

export function getMeta(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string | null }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function upsertSession(db: Database.Database, session: Session): void {
  db.prepare(
    `INSERT INTO sessions(
       id, agent, project, cwd, title, path, started_at, updated_at,
       settled, gave_up, pasted, words, sidechain
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       agent = excluded.agent,
       project = excluded.project,
       cwd = excluded.cwd,
       title = COALESCE(NULLIF(excluded.title, ''), sessions.title),
       path = excluded.path,
       started_at = COALESCE(sessions.started_at, excluded.started_at),
       updated_at = COALESCE(excluded.updated_at, sessions.updated_at),
       settled = MAX(sessions.settled, excluded.settled),
       gave_up = MAX(sessions.gave_up, excluded.gave_up),
       pasted = MAX(sessions.pasted, excluded.pasted),
       words = sessions.words + excluded.words,
       sidechain = MAX(sessions.sidechain, excluded.sidechain)`,
  ).run(
    session.id,
    session.agent,
    session.project,
    session.cwd,
    session.title,
    session.path,
    session.startedAt,
    session.updatedAt,
    Number(session.settled),
    Number(session.gaveUp),
    Number(session.pasted),
    session.words,
    Number(session.sidechain),
  );
}

export function putSessionExact(db: Database.Database, session: Session): void {
  db.prepare(
    `INSERT INTO sessions(
       id, agent, project, cwd, title, path, started_at, updated_at,
       settled, gave_up, pasted, words, sidechain
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       agent = excluded.agent,
       project = excluded.project,
       cwd = excluded.cwd,
       title = excluded.title,
       path = excluded.path,
       started_at = excluded.started_at,
       updated_at = excluded.updated_at,
       settled = excluded.settled,
       gave_up = excluded.gave_up,
       pasted = excluded.pasted,
       words = excluded.words,
       sidechain = excluded.sidechain`,
  ).run(
    session.id,
    session.agent,
    session.project,
    session.cwd,
    session.title,
    session.path,
    session.startedAt,
    session.updatedAt,
    Number(session.settled),
    Number(session.gaveUp),
    Number(session.pasted),
    session.words,
    Number(session.sidechain),
  );
}

export function insertNoteRow(db: Database.Database, note: Note): void {
  db.prepare(
    `INSERT INTO notes(id, scope, project, kind, text, state, created, source,
                       supersedes, written_by, superseded_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    note.id,
    note.scope,
    note.project,
    note.kind,
    note.text,
    note.state,
    note.created,
    note.source,
    note.supersedes,
    note.writtenBy,
    note.supersededAt,
  );
  db.prepare(
    "INSERT INTO notes_fts(rowid, tokens) VALUES ((SELECT rowid FROM notes WHERE id = ?), ?)",
  ).run(note.id, tokenize(note.text).join(" "));
}

export function saveNote(db: Database.Database, note: Note): void {
  insertNoteRow(db, note);
  if (note.supersedes) {
    db.prepare(
      `UPDATE notes SET state = 'superseded', superseded_at = ?
       WHERE id = ? AND state = 'active'`,
    ).run(note.created, note.supersedes);
  }
}

export interface MessageInput {
  sid: string;
  ordinal: number;
  ts: string | null;
  role: MessageRole;
  kind: string;
  text: string;
  meta?: string | null;
}

export function addMessage(db: Database.Database, message: MessageInput): number {
  const row = db
    .prepare(
      `INSERT INTO msgs(sid, ordinal, ts, role, kind, text, meta)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sid, ordinal) DO UPDATE SET
         ts = excluded.ts,
         role = excluded.role,
         kind = excluded.kind,
         text = excluded.text,
         meta = excluded.meta
       RETURNING id`,
    )
    .get(
      message.sid,
      message.ordinal,
      message.ts,
      message.role,
      message.kind,
      message.text,
      message.meta ?? null,
    ) as { id: number };
  return row.id;
}

export function getMessage(db: Database.Database, sid: string, ordinal: number): Message | null {
  const row = db
    .prepare(
      `SELECT id, sid, ordinal, ts, role, kind, text, meta
       FROM msgs WHERE sid = ? AND ordinal = ?`,
    )
    .get(sid, ordinal) as Message | undefined;
  return row ?? null;
}

export function upsertFileState(db: Database.Database, state: FileState): void {
  db.prepare(
    `INSERT INTO files(path, agent, size, mtime_ns, offset, line_no, prefix_sample, sid)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(path) DO UPDATE SET
       agent = excluded.agent,
       size = excluded.size,
       mtime_ns = excluded.mtime_ns,
       offset = excluded.offset,
       line_no = excluded.line_no,
       prefix_sample = excluded.prefix_sample,
       sid = excluded.sid`,
  ).run(
    state.path,
    state.agent,
    state.size,
    state.mtimeNs,
    state.offset,
    state.lineNo,
    state.prefixSample,
    state.sid,
  );
}

export function getFileState(db: Database.Database, path: string): FileState | null {
  const row = db
    .prepare(
      `SELECT path, agent, size, CAST(mtime_ns AS TEXT) AS mtime_ns, offset, line_no, prefix_sample, sid
       FROM files WHERE path = ?`,
    )
    .get(path) as
    | {
        path: string;
        agent: FileState["agent"];
        size: number;
        mtime_ns: string;
        offset: number;
        line_no: number;
        prefix_sample: Buffer;
        sid: string | null;
      }
    | undefined;
  if (!row) {
    return null;
  }
  return {
    path: row.path,
    agent: row.agent,
    size: row.size,
    mtimeNs: BigInt(row.mtime_ns),
    offset: row.offset,
    lineNo: row.line_no,
    prefixSample: new Uint8Array(row.prefix_sample),
    sid: row.sid,
  };
}

export function deleteSessionData(db: Database.Database, sid: string): void {
  db.prepare("DELETE FROM session_terms WHERE sid = ?").run(sid);
  db.prepare("DELETE FROM msgs_fts WHERE rowid IN (SELECT id FROM msgs WHERE sid = ?)").run(sid);
  db.prepare("DELETE FROM msgs WHERE sid = ?").run(sid);
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sid);
}
