import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as zlib from "node:zlib";

import { readAntigravityTranscript } from "../src/parsers/antigravity.js";
import { readDshSession } from "../src/parsers/dsh.js";
import { parsePiLine } from "../src/parsers/pi.js";
import { parseQoderLine } from "../src/parsers/qoder.js";

const zstd = zlib as unknown as {
  zstdCompressSync?: (buffer: Buffer) => Buffer;
};

test("qoder reuses the Claude parser", () => {
  const line = JSON.stringify({
    type: "assistant",
    timestamp: "2026-11-01T00:00:00.000Z",
    cwd: "/work/demo",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "先看配置。" },
        {
          type: "tool_use",
          id: "tool-1",
          name: "bash",
          input: { command: "git config --show-origin user.email" },
        },
      ],
    },
  });
  const parsed = parseQoderLine(line, "sid-qoder", 3, "demo");
  assert.ok(parsed);
  assert.equal(parsed.role, "tool_call");
  assert.match(parsed.text, /先看配置。/);
  assert.match(parsed.text, /bash: /);
  assert.equal(parsed.cwd, "/work/demo");
  assert.equal(parsed.ordinal, 3);
});

test("pi maps session header, messages, tool calls and tool results", () => {
  const session = parsePiLine(
    JSON.stringify({
      type: "session",
      version: 1,
      id: "pi-session",
      timestamp: "2026-11-02T00:00:00.000Z",
      cwd: "/work/pi",
    }),
    "fallback",
    0,
  );
  assert.deepEqual(session, {
    type: "session",
    value: { sid: "pi-session", timestamp: "2026-11-02T00:00:00.000Z", cwd: "/work/pi" },
  });

  const user = parsePiLine(
    JSON.stringify({
      type: "message",
      timestamp: "2026-11-02T00:00:01.000Z",
      message: { role: "user", content: [{ type: "text", text: "索引构建失败" }] },
    }),
    "pi-session",
    1,
  );
  assert.equal(user?.type, "message");
  assert.equal(user?.value.role, "user");
  assert.equal(user?.value.text, "索引构建失败");

  const assistant = parsePiLine(
    JSON.stringify({
      type: "message",
      timestamp: "2026-11-02T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "hidden" },
          { type: "text", text: "气道上皮受损。" },
          { type: "toolCall", id: "c1", name: "read", arguments: '{"path":"/tmp/a"}' },
        ],
      },
    }),
    "pi-session",
    2,
  );
  assert.equal(assistant?.type, "message");
  assert.equal(assistant?.value.role, "tool_call");
  assert.match(assistant?.value.text ?? "", /气道上皮受损。/);
  assert.match(assistant?.value.text ?? "", /read: \{"path":"\/tmp\/a"\}/);
  assert.doesNotMatch(assistant?.value.text ?? "", /hidden/);

  const toolResult = parsePiLine(
    JSON.stringify({
      type: "message",
      timestamp: "2026-11-02T00:00:03.000Z",
      message: {
        role: "toolResult",
        toolName: "read",
        content: [{ type: "text", text: "文件内容" }],
      },
    }),
    "pi-session",
    3,
  );
  assert.equal(toolResult?.type, "message");
  assert.equal(toolResult?.value.role, "tool_result");
  assert.equal(toolResult?.value.kind, "read");
});

test("dsh decodes concatenated zstd frames and orders by seq", (t) => {
  if (!zstd.zstdCompressSync) {
    t.skip("zstdCompressSync unavailable on this Node");
    return;
  }
  const frame = (events: unknown[]) =>
    zstd.zstdCompressSync!(Buffer.from(events.map((e) => JSON.stringify(e)).join("\n") + "\n"));
  const first = frame([
    {
      type: "user/message",
      seq: 2,
      time: Date.parse("2026-11-03T00:00:02.000Z"),
      data: { content: [{ type: "text", text: "看下 lattice 状态" }] },
    },
    {
      type: "tool/call",
      seq: 3,
      time: Date.parse("2026-11-03T00:00:03.000Z"),
      data: { name: "bash", arguments: '{"command":"git status"}' },
    },
  ]);
  const second = frame([
    {
      type: "assistant/message",
      seq: 4,
      time: Date.parse("2026-11-03T00:00:04.000Z"),
      data: { message: { content: [{ type: "reasoning", text: "隐藏" }, { type: "text", text: "工作区干净。" }] } },
    },
    {
      type: "tool/result",
      seq: 5,
      time: Date.parse("2026-11-03T00:00:05.000Z"),
      data: { message: { content: [{ type: "text", text: "nothing to commit" }] }, meta: { cwd: "/work/lattice" } },
    },
  ]);
  const root = mkdtempSync(join(tmpdir(), "mem-dsh-"));
  try {
    const path = join(root, "session.v4.jsonl.zstd");
    writeFileSync(path, Buffer.concat([first, second]));
    const session = readDshSession(path, "dsh-session");
    assert.equal(session.sid, "dsh-session");
    assert.equal(session.cwd, "/work/lattice");
    assert.deepEqual(
      session.messages.map((message) => message.role),
      ["user", "tool_call", "assistant", "tool_result"],
    );
    assert.match(session.messages[1]!.text, /bash: \{"command":"git status"\}/);
    assert.equal(session.messages[2]!.text, "工作区干净。");
    assert.equal(session.messages[3]!.text, "nothing to commit");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("antigravity maps transcript_full lines", () => {
  const root = mkdtempSync(join(tmpdir(), "mem-antigravity-"));
  try {
    const path = join(root, "transcript_full.jsonl");
    const lines = [
      {
        type: "USER_INPUT",
        created_at: "2026-11-04T00:00:00Z",
        content:
          "<USER_REQUEST>\n跑一遍 credit 验收\n</USER_REQUEST>\n<ADDITIONAL_METADATA>noise</ADDITIONAL_METADATA>",
      },
      {
        type: "PLANNER_RESPONSE",
        created_at: "2026-11-04T00:00:01Z",
        content: "开始验收。",
        thinking: "hidden",
        tool_calls: [{ name: "run_command", args: { CommandLine: "npm test" } }],
      },
      {
        type: "GENERIC",
        created_at: "2026-11-04T00:00:02Z",
        content: "Command exited with code 0.",
      },
      {
        type: "CHECKPOINT",
        created_at: "2026-11-04T00:00:03Z",
        content: "Resuming from a compaction",
      },
      { type: "SYSTEM_MESSAGE", created_at: "2026-11-04T00:00:04Z", content: "system noise" },
    ];
    writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    const session = readAntigravityTranscript(path, "agy-session");
    assert.equal(session.sid, "agy-session");
    assert.deepEqual(
      session.messages.map((message) => message.role),
      ["user", "tool_call", "tool_result", "compaction"],
    );
    assert.equal(session.messages[0]!.text, "跑一遍 credit 验收");
    assert.match(session.messages[1]!.text, /^开始验收。\nrun_command: /);
    assert.doesNotMatch(session.messages[1]!.text, /hidden/);
    assert.equal(session.messages[2]!.text, "Command exited with code 0.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
