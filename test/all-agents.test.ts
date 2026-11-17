import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import Database from "better-sqlite3";

import { openDatabase } from "../src/db.js";
import { indexAll } from "../src/index.js";
import { zstdAvailable } from "../src/parsers/dsh.js";
import { searchSessions } from "../src/search.js";

import * as zlib from "node:zlib";

const zstd = zlib as unknown as {
  zstdCompressSync?: (buffer: Buffer) => Buffer;
};

const MARKER = "zzmarker coverage";
const AT = "2026-11-12T00:00:00.000Z";

function claudeLine(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({
    type: role,
    timestamp,
    cwd: "/home/dev",
    isSidechain: false,
    message: { role, content: [{ type: "text", text }] },
  });
}

function codexLines(sid: string): string {
  const session = {
    timestamp: AT,
    type: "session_meta",
    payload: { id: sid, cwd: "/home/dev", timestamp: AT },
  };
  const message = (kind: "UserMessage" | "AgentMessage", text: string) =>
    JSON.stringify({
      timestamp: AT,
      type: "event_msg",
      payload: { type: "item_completed", item: { type: kind, content: [{ type: "text", text }] } },
    });
  return [
    JSON.stringify(session),
    message("UserMessage", `${MARKER} from codex`),
    message("AgentMessage", "codex 已记录。"),
    "",
  ].join("\n");
}

function makeOpencode(path: string, sid: string): void {
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
  ).run(sid, "opencode fixture", "/home/dev", 1_700_000_000_000, 1_700_000_001_000);
  const insert = db.prepare(
    `INSERT INTO session_message(id, session_id, type, seq, time_created, data)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    `${sid}-u`,
    sid,
    "user",
    0,
    1_700_000_000_000,
    JSON.stringify({ text: `${MARKER} from opencode` }),
  );
  insert.run(
    `${sid}-a`,
    sid,
    "assistant",
    1,
    1_700_000_001_000,
    JSON.stringify({ content: [{ type: "text", text: "opencode 已记录。" }] }),
  );
  db.close();
}

function writeDsh(root: string, sid: string, events: unknown[]): string {
  const directory = join(root, `session-${sid}`);
  mkdirSync(directory, { recursive: true });
  const body = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
  writeFileSync(join(directory, "session.v4.jsonl.zstd"), zstd.zstdCompressSync!(Buffer.from(body)));
  return directory;
}

test("one index run ingests all seven agents and one query crosses their pools", async (t) => {
  if (!zstd.zstdCompressSync || !zstdAvailable()) {
    t.skip("需要 Node >= 22.15 的 zlib zstd 支持");
    return;
  }
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-all-agents-"));
  try {
    const claudeRoot = join(directory, "claude");
    const codexRoot = join(directory, "codex");
    const qoderRoot = join(directory, "qoder");
    const piRoot = join(directory, "pi");
    const dshRoot = join(directory, "dsh");
    const agyRoot = join(directory, "antigravity");
    const opencodePath = join(directory, "opencode.db");

    const claudeSid = "11111111-1111-4111-8111-111111111111";
    mkdirSync(join(claudeRoot, "-home-dev"), { recursive: true });
    writeFileSync(
      join(claudeRoot, "-home-dev", `${claudeSid}.jsonl`),
      [
        claudeLine("user", `${MARKER} from claude`, AT),
        claudeLine("assistant", "claude 已记录。", AT),
        "",
      ].join("\n"),
    );

    const codexSid = "22222222-2222-4222-8222-222222222222";
    mkdirSync(join(codexRoot, "2026/11/12"), { recursive: true });
    writeFileSync(join(codexRoot, "2026/11/12", `rollout-${codexSid}.jsonl`), codexLines(codexSid));

    makeOpencode(opencodePath, "opencode-all-agents");

    const qoderSid = "33333333-3333-4333-8333-333333333333";
    mkdirSync(join(qoderRoot, "-home-dev-qoder"), { recursive: true });
    writeFileSync(
      join(qoderRoot, "-home-dev-qoder", `${qoderSid}.jsonl`),
      [
        claudeLine("user", `${MARKER} from qoder`, AT),
        claudeLine("assistant", "qoder 已记录。", AT),
        "",
      ].join("\n"),
    );

    const piSid = "44444444-4444-4444-8444-444444444444";
    mkdirSync(join(piRoot, "--home-dev--"), { recursive: true });
    writeFileSync(
      join(piRoot, "--home-dev--", `2026-11-12T00-00-00-000Z_${piSid}.jsonl`),
      [
        JSON.stringify({
          type: "session",
          version: 1,
          id: piSid,
          timestamp: AT,
          cwd: "/home/dev",
        }),
        JSON.stringify({
          type: "message",
          timestamp: AT,
          message: { role: "user", content: [{ type: "text", text: `${MARKER} from pi` }] },
        }),
        JSON.stringify({
          type: "message",
          timestamp: AT,
          message: { role: "assistant", content: [{ type: "text", text: "pi 已记录。" }] },
        }),
        "",
      ].join("\n"),
    );

    const dshSid = "55555555-5555-4555-8555-555555555555";
    writeDsh(dshRoot, dshSid, [
      {
        type: "user/message",
        seq: 1,
        time: Date.parse(AT),
        data: { content: [{ type: "text", text: `${MARKER} from dsh` }] },
      },
      {
        type: "assistant/message",
        seq: 2,
        time: Date.parse(AT) + 1_000,
        data: { message: { content: [{ type: "text", text: "dsh 已记录。" }] } },
      },
    ]);

    const agySid = "66666666-6666-4666-8666-666666666666";
    const agyLogs = join(agyRoot, agySid, ".system_generated", "logs");
    mkdirSync(agyLogs, { recursive: true });
    writeFileSync(
      join(agyLogs, "transcript_full.jsonl"),
      [
        JSON.stringify({
          type: "USER_INPUT",
          created_at: AT,
          content: `<USER_REQUEST>\n${MARKER} from antigravity\n</USER_REQUEST>`,
        }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          created_at: AT,
          content: "antigravity 已记录。",
        }),
        "",
      ].join("\n"),
    );

    const dbPath = join(directory, "mem.db");
    const stats = await indexAll({
      dbPath,
      quiet: true,
      roots: {
        claude: claudeRoot,
        codex: codexRoot,
        opencode: opencodePath,
        qoder: qoderRoot,
        pi: piRoot,
        dsh: dshRoot,
        antigravity: agyRoot,
      },
    });

    assert.deepEqual(stats.errors, []);
    assert.equal(stats.filesScanned, 7);
    assert.equal(stats.sessions, 7);

    const db = openDatabase(dbPath);
    try {
      const byAgent = db
        .prepare("SELECT agent, count(*) AS n FROM sessions GROUP BY agent ORDER BY agent")
        .all() as Array<{ agent: string; n: number }>;
      assert.deepEqual(byAgent, [
        { agent: "antigravity", n: 1 },
        { agent: "claude", n: 1 },
        { agent: "codex", n: 1 },
        { agent: "dsh", n: 1 },
        { agent: "opencode", n: 1 },
        { agent: "pi", n: 1 },
        { agent: "qoder", n: 1 },
      ]);

      const messages = db
        .prepare("SELECT s.agent, count(*) AS n FROM msgs m JOIN sessions s ON s.id = m.sid GROUP BY s.agent ORDER BY s.agent")
        .all() as Array<{ agent: string; n: number }>;
      assert.deepEqual(
        messages.map((row) => row.agent),
        ["antigravity", "claude", "codex", "dsh", "opencode", "pi", "qoder"],
      );
      for (const row of messages) {
        assert.ok(row.n >= 2, `${row.agent} 只入库了 ${row.n} 条消息`);
      }

      const result = searchSessions(db, MARKER, { limit: 20, now: new Date(AT) });
      assert.equal(result.tier, "exact");
      assert.equal(result.hits.length, 7);
      assert.deepEqual(
        result.hits.map((hit) => hit.agent).sort(),
        ["antigravity", "claude", "codex", "dsh", "opencode", "pi", "qoder"],
      );
      assert.ok(result.hits.every((hit) => hit.matched >= 2));
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
