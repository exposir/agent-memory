import assert from "node:assert/strict";
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { getFileState, openDatabase } from "../src/db.js";
import { indexAll } from "../src/index.js";

function withTempDir(run: (directory: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-memory-index-"));
    try {
      await run(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function claudeLine(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({
    type: role,
    timestamp,
    cwd: "/home/dev",
    isSidechain: false,
    message: { role, content: [{ type: "text", text }] },
  });
}

function codexSessionLine(): string {
  return JSON.stringify({
    timestamp: "2026-11-12T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: "codex-fixture",
      cwd: "/home/dev",
      timestamp: "2026-11-12T00:00:00.000Z",
    },
  });
}

function codexMessageLine(kind: "UserMessage" | "AgentMessage", text: string): string {
  return JSON.stringify({
    timestamp: "2026-11-12T00:00:01.000Z",
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: kind,
        content: [{ type: "text", text }],
      },
    },
  });
}

function makeOpencode(path: string): void {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY,
      title TEXT,
      directory TEXT NOT NULL,
      time_created INTEGER NOT NULL,
      time_updated INTEGER NOT NULL
    );
    CREATE TABLE session_message (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      time_created INTEGER NOT NULL,
      data TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO session_v2(id, title, directory, time_created, time_updated)
     VALUES (?, ?, ?, ?, ?)`,
  ).run("opencode-fixture", "fixture", "/home/dev", 1_700_000_000_000, 1_700_000_001_000);
  db.prepare(
    `INSERT INTO session_message(id, session_id, type, seq, time_created, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "opencode-u",
    "opencode-fixture",
    "user",
    0,
    1_700_000_000_000,
    JSON.stringify({ text: "opencode question fixture" }),
  );
  db.prepare(
    `INSERT INTO session_message(id, session_id, type, seq, time_created, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    "opencode-a",
    "opencode-fixture",
    "assistant",
    1,
    1_700_000_001_000,
    JSON.stringify({ content: [{ type: "text", text: "opencode answer fixture" }] }),
  );
  db.close();
}

test(
  "indexes Claude, Codex, and opencode fixtures with roles and FTS rows",
  withTempDir(async (directory) => {
    const claudeRoot = join(directory, "claude");
    const codexRoot = join(directory, "codex");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "claude-fixture.jsonl"),
      [
        claudeLine("user", "claude question fixture", "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "决定：claude answer fixture", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    const codexPath = join(codexRoot, "2026/11/12");
    mkdirSync(codexPath, { recursive: true });
    writeFileSync(
      join(codexPath, "rollout-fixture.jsonl"),
      [
        codexSessionLine(),
        codexMessageLine("UserMessage", "codex question fixture"),
        codexMessageLine("AgentMessage", "结论：codex answer fixture"),
        "",
      ].join("\n"),
    );
    const opencode = join(directory, "opencode.db");
    makeOpencode(opencode);
    const dbPath = join(directory, "mem.db");
    const stats = await indexAll({
      dbPath,
      quiet: true,
      roots: {
        claude: claudeRoot,
        codex: codexRoot,
        opencode,
        qoder: "",
        pi: "",
        dsh: "",
        antigravity: "",
      },
    });

    assert.equal(stats.filesScanned, 3);
    assert.equal(stats.messages, 6);
    assert.equal(stats.sessions, 3);

    const db = openDatabase(dbPath);
    const roles = db.prepare("SELECT role, count(*) AS n FROM msgs GROUP BY role").all() as Array<{
      role: string;
      n: number;
    }>;
    assert.equal(roles.find((row) => row.role === "user")?.n, 3);
    assert.equal(roles.find((row) => row.role === "assistant")?.n, 3);
    assert.equal((db.prepare("SELECT count(*) AS n FROM msgs_fts").get() as { n: number }).n, 6);
    assert.equal((db.prepare("SELECT count(*) AS n FROM files").get() as { n: number }).n, 3);
    db.close();
  }),
);

test(
  "appends only after a safe newline boundary and rebuilds rewritten files",
  withTempDir(async (directory) => {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const file = join(project, "append.jsonl");
    const first = `${claudeLine("user", "first complete fixture", "2026-11-12T00:00:00.000Z")}\n`;
    writeFileSync(file, first);
    const dbPath = join(directory, "mem.db");
    const roots = {
      claude: claudeRoot,
      codex: join(directory, "empty-codex"),
      opencode: join(directory, "missing.db"),
      qoder: "",
      pi: "",
      dsh: "",
      antigravity: "",
    };

    let stats = await indexAll({ dbPath, quiet: true, roots });
    assert.equal(stats.messages, 1);

    appendFileSync(file, claudeLine("assistant", "half line without newline", "2026-11-12T00:00:01.000Z"));
    stats = await indexAll({ dbPath, quiet: true, roots });
    assert.equal(stats.messages, 1);

    appendFileSync(file, "\n");
    stats = await indexAll({ dbPath, quiet: true, roots });
    assert.equal(stats.messages, 2);

    writeFileSync(
      file,
      [
        claudeLine("user", "rewritten alpha fixture", "2026-11-12T00:02:00.000Z"),
        claudeLine("assistant", "rewritten beta fixture", "2026-11-12T00:02:01.000Z"),
        "",
      ].join("\n"),
    );
    stats = await indexAll({ dbPath, quiet: true, roots });
    assert.equal(stats.messages, 2);
    assert.equal(stats.filesRebuilt, 1);

    const db = openDatabase(dbPath);
    const state = getFileState(db, file);
    assert.equal(state?.offset, Buffer.byteLength(readFileSync(file, "utf8")));
    db.close();
  }),
);

test(
  "skips a physical line larger than two megabytes",
  withTempDir(async (directory) => {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const file = join(project, "large.jsonl");
    const large = `${"x".repeat(2_000_010)}\n`;
    writeFileSync(
      file,
      large + claudeLine("user", "small after large", "2026-11-12T00:00:00.000Z") + "\n",
    );
    const stats = await indexAll({
      dbPath: join(directory, "mem.db"),
      quiet: true,
      roots: {
        claude: claudeRoot,
        codex: join(directory, "empty-codex"),
        opencode: join(directory, "missing.db"),
        qoder: "",
        pi: "",
        dsh: "",
        antigravity: "",
      },
    });
    assert.equal(stats.messages, 1);
  }),
);

test(
  "does not commit a file watermark when the message transaction fails",
  withTempDir(async (directory) => {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const file = join(project, "rollback.jsonl");
    writeFileSync(
      file,
      [
        claudeLine("user", "first fixture is valid", "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "TRIGGER_FAIL fixture", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    const dbPath = join(directory, "mem.db");
    const setup = openDatabase(dbPath);
    setup.exec(`
      CREATE TRIGGER fixture_failure
      BEFORE INSERT ON msgs
      WHEN NEW.text LIKE '%TRIGGER_FAIL%'
      BEGIN
        SELECT RAISE(ABORT, 'fixture failure');
      END;
    `);
    setup.close();

    const stats = await indexAll({
      dbPath,
      quiet: true,
      roots: {
        claude: claudeRoot,
        codex: join(directory, "empty-codex"),
        opencode: join(directory, "missing.db"),
        qoder: "",
        pi: "",
        dsh: "",
        antigravity: "",
      },
    });
    assert.equal(stats.errors.length, 1);
    assert.equal(stats.messages, 0);

    const db = openDatabase(dbPath);
    assert.equal(getFileState(db, file), null);
    db.close();
  }),
);

test(
  "refuses a second indexer when the lock pid is alive",
  withTempDir(async (directory) => {
    const dbPath = join(directory, "mem.db");
    writeFileSync(`${dbPath}.index.lock`, `${process.pid}\n2026-11-12T00:00:00.000Z\n`);
    await assert.rejects(
      indexAll({
        dbPath,
        quiet: true,
        roots: {
          claude: join(directory, "empty-claude"),
          codex: join(directory, "empty-codex"),
          opencode: join(directory, "missing.db"),
          qoder: "",
          pi: "",
          dsh: "",
          antigravity: "",
        },
      }),
      /another indexer is running/,
    );
  }),
);

