import assert from "node:assert/strict";
import test from "node:test";

import {
  addMessage,
  createSchema,
  getFileState,
  getMessage,
  getMeta,
  openDatabase,
  setMeta,
  upsertFileState,
  upsertSession,
} from "../src/db.js";
import Database from "better-sqlite3";

test("creates the M1 schema with role and prefix_sample", () => {
  const db = openDatabase(":memory:");
  const messageColumns = db.prepare("PRAGMA table_info(msgs)").all() as Array<{ name: string }>;
  const fileColumns = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
  const fts = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'msgs_fts'")
    .get() as { name: string } | undefined;

  assert.ok(messageColumns.some((column) => column.name === "role"));
  assert.ok(fileColumns.some((column) => column.name === "prefix_sample"));
  assert.equal(fts?.name, "msgs_fts");
  db.close();
});

test("round-trips messages, file watermarks, and metadata", () => {
  const db = openDatabase(":memory:");
  upsertSession(db, {
    id: "sid-1",
    agent: "codex",
    project: "/home/dev",
    cwd: "/home/dev",
    title: "fixture",
    path: "/tmp/fixture.jsonl",
    startedAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:01:00.000Z",
    settled: false,
    gaveUp: false,
    pasted: false,
    words: 3,
    sidechain: false,
  });
  const id = addMessage(db, {
    sid: "sid-1",
    ordinal: 0,
    ts: "2026-11-12T00:00:00.000Z",
    role: "user",
    kind: "UserMessage",
    text: "fixture prompt",
  });
  assert.equal(id > 0, true);
  assert.equal(getMessage(db, "sid-1", 0)?.text, "fixture prompt");

  upsertFileState(db, {
    path: "/tmp/fixture.jsonl",
    agent: "codex",
    size: 42,
    mtimeNs: 123n,
    offset: 10,
    lineNo: 2,
    prefixSample: new Uint8Array([1, 2, 3, 4]),
    sid: "sid-1",
  });
  assert.deepEqual(getFileState(db, "/tmp/fixture.jsonl")?.prefixSample, new Uint8Array([1, 2, 3, 4]));

  setMeta(db, "schema_version", "1");
  assert.equal(getMeta(db, "schema_version"), "1");
  db.close();
});

test("migrates a pre-correction notes table without rebuilding the index", () => {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE notes (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL CHECK(scope IN ('global','repo')),
      project TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      created TEXT,
      source TEXT
    );
    INSERT INTO notes(id, scope, project, kind, text, state, created, source)
    VALUES ('old-note', 'global', NULL, 'fact', '旧结论', 'active', '2026-11-01T00:00:00.000Z', NULL);
  `);

  createSchema(db);

  const columns = (db.prepare("PRAGMA table_info(notes)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
  for (const name of ["supersedes", "written_by", "superseded_at"]) {
    assert.ok(columns.includes(name));
  }
  assert.equal(
    (db.prepare("SELECT text FROM notes WHERE id = 'old-note'").get() as { text: string }).text,
    "旧结论",
  );

  // Idempotent: a database created by the current schema still opens cleanly.
  assert.doesNotThrow(() => createSchema(db));
  db.close();
});
