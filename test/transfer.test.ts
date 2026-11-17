import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getMeta,
  openDatabase,
  openReadDatabase,
  saveNote,
  setMeta,
  upsertFileState,
  upsertSession,
} from "../src/db.js";
import { exportAll } from "../src/export.js";
import { insertMessage } from "../src/ingest.js";
import { restoreAll } from "../src/restore.js";
import type { Note } from "../src/types.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "mem-transfer-"));
  return { root, dbPath: join(root, "source.db"), outDir: join(root, "export") };
}

test("export then restore round-trips sessions, messages, FTS, files and notes", () => {
  const { root, dbPath, outDir } = fixture();
  try {
    const db = openDatabase(dbPath);
    upsertSession(db, {
      id: "sid-cn",
      agent: "claude",
      project: "/work/demo",
      cwd: "/work/demo",
      title: "面板配置",
      path: "/work/demo/session.jsonl",
      startedAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:01:00.000Z",
      settled: true,
      gaveUp: false,
      pasted: false,
      words: 42,
      sidechain: false,
    });
    insertMessage(db, {
      sid: "sid-cn",
      ordinal: 1,
      timestamp: "2026-11-01T00:00:10.000Z",
      role: "user",
      kind: "text",
      text: "面板的 hasconfig 规则怎么配？",
      cwd: "/work/demo",
    });
    insertMessage(db, {
      sid: "sid-cn",
      ordinal: 2,
      timestamp: "2026-11-01T00:00:20.000Z",
      role: "assistant",
      kind: "text",
      text: "用 git config --show-origin 查 includeIf。",
      cwd: "/work/demo",
    });
    upsertFileState(db, {
      path: "/work/demo/session.jsonl",
      agent: "claude",
      size: 1234,
      mtimeNs: 1_700_000_000_000_000_123n,
      offset: 1200,
      lineNo: 2,
      prefixSample: new Uint8Array([0, 1, 2, 255]),
      sid: "sid-cn",
    });
    setMeta(db, "indexed_at", "2026-11-01T00:02:00.000Z");
    const first: Note = {
      id: "note-1",
      scope: "global",
      project: null,
      kind: "fact",
      text: "旧规则 A",
      state: "active",
      created: "2026-11-01T00:03:00.000Z",
      source: null,
      supersedes: null,
      writtenBy: "human",
      supersededAt: null,
    };
    const second: Note = {
      id: "note-2",
      scope: "global",
      project: null,
      kind: "fact",
      text: "新规则 B",
      state: "active",
      created: "2026-11-01T00:04:00.000Z",
      source: null,
      supersedes: "note-1",
      writtenBy: "human",
      supersededAt: null,
    };
    saveNote(db, first);
    saveNote(db, second);
    db.close();

    const logPath = join(root, "notes-log.jsonl");
    const logBody = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;
    writeFileSync(logPath, logBody);
    const previousLog = process.env.MEM_GLOBAL_NOTES;
    process.env.MEM_GLOBAL_NOTES = logPath;
    try {
      const exported = exportAll({ dbPath, outDir });
      assert.equal(exported.sessions, 1);
      assert.equal(exported.messages, 2);
      assert.equal(exported.files, 1);
      assert.equal(exported.notes, 2);
      assert.equal(
        readFileSync(join(outDir, "notes", "notes.jsonl"), "utf8"),
        logBody,
      );
    } finally {
      if (previousLog === undefined) {
        delete process.env.MEM_GLOBAL_NOTES;
      } else {
        process.env.MEM_GLOBAL_NOTES = previousLog;
      }
    }

    const restoredPath = join(root, "restored.db");
    const restored = restoreAll({ fromDir: outDir, dbPath: restoredPath });
    assert.equal(restored.sessions, 1);
    assert.equal(restored.messages, 2);
    assert.equal(restored.files, 1);
    assert.equal(restored.notes, 2);

    const source = openReadDatabase(dbPath);
    const copy = openReadDatabase(restoredPath);
    const tokens = (database: typeof source) =>
      database
        .prepare(
          `SELECT m.sid, m.ordinal, f.tokens, f.utokens
           FROM msgs m JOIN msgs_fts f ON f.rowid = m.id
           ORDER BY m.sid, m.ordinal`,
        )
        .all();
    assert.deepEqual(tokens(copy), tokens(source));
    const ids = (database: typeof source) =>
      database.prepare("SELECT sid, ordinal, id FROM msgs ORDER BY sid, ordinal").all();
    assert.deepEqual(ids(copy), ids(source));
    const terms = (database: typeof source) =>
      database
        .prepare("SELECT term, sid, tf, user_tf FROM session_terms ORDER BY term, sid")
        .all();
    assert.deepEqual(terms(copy), terms(source));
    assert.equal(
      (copy.prepare("SELECT words FROM sessions WHERE id = ?").get("sid-cn") as { words: number })
        .words,
      42,
    );
    assert.equal(
      (copy.prepare("SELECT hex(prefix_sample) AS p FROM files").get() as { p: string }).p,
      "000102FF",
    );
    assert.equal(getMeta(copy, "indexed_at"), "2026-11-01T00:02:00.000Z");
    const notes = copy
      .prepare("SELECT id, state, supersedes FROM notes ORDER BY id")
      .all() as Array<{ id: string; state: string; supersedes: string | null }>;
    assert.deepEqual(notes, [
      { id: "note-1", state: "superseded", supersedes: null },
      { id: "note-2", state: "active", supersedes: "note-1" },
    ]);
    source.close();
    copy.close();

    assert.throws(
      () => restoreAll({ fromDir: outDir, dbPath: restoredPath }),
      /拒绝覆盖/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
