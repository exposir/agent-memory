import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { openDatabase } from "../src/db.js";
import { indexAll } from "../src/index.js";
import {
  extractPathHint,
  normalizeQuery,
  searchSessions,
  stripQueryFrame,
} from "../src/search.js";

function claudeLine(role: "user" | "assistant", text: string, timestamp: string): string {
  return JSON.stringify({
    type: role,
    timestamp,
    cwd: "/home/dev",
    isSidechain: false,
    message: { role, content: [{ type: "text", text }] },
  });
}

test("ranks exact candidates and applies decision, note, and role boosts", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "target.jsonl"),
      [
        claudeLine("user", "alpha beta pgbouncer 应该怎么修？", "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "决定：pgbouncer 连接池已经修好。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(project, "distractor.jsonl"),
      [
        claudeLine("user", "alpha beta pgbouncer 只是提一下。", "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "继续观察连接池。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    db.prepare(
      "INSERT INTO notes(id, scope, project, kind, text, state, source) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "note-1",
      "global",
      null,
      "fact",
      "alpha beta pgbouncer",
      "active",
      "target",
    );
    const result = searchSessions(db, "alpha beta pgbouncer", {
      limit: 5,
      excludedSids: ["distractor"],
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.tier, "exact");
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.sid, "target");
    assert.equal(result.hits[0]!.matched, 3);
    assert.equal(result.hits[0]!.naming >= 1, true);

    const framed = searchSessions(db, "想确认一下：alpha beta pgbouncer", {
      limit: 5,
      excludedSids: ["distractor"],
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(framed.tier, "exact");
    assert.equal(framed.hits[0]?.sid, "target");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("falls back through OR when no session holds every term in one message", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-fallback-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "fallback.jsonl"),
      [
        claudeLine("user", "alpha beta 这两个词先排查。", "2026-11-12T00:00:00.000Z"),
        claudeLine("user", "gamma 也在报错。", "2026-11-12T00:00:01.000Z"),
        claudeLine("assistant", "决定：三者都已经隔离。", "2026-11-12T00:00:02.000Z"),
        "",
      ].join("\n"),
    );
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const result = searchSessions(db, "alpha beta gamma", {
      limit: 5,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.tier, "relevance");
    assert.equal(result.hits.length, 1);
    assert.equal(result.hits[0]!.sid, "fallback");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a long query keeps its highest-IDF terms instead of falling straight to OR", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-focused-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const targetTerms = [
      "alpha",
      "bravo",
      "charlie",
      "delta",
      "echo",
      "foxtrot",
      "golf",
      "hotel",
    ];
    writeFileSync(
      join(project, "target.jsonl"),
      [
        claudeLine("user", `${targetTerms.join(" ")} 怎么处理？`, "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "决定：alpha 和 charlie 都已处理。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    for (let index = 0; index < 10; index += 1) {
      writeFileSync(
        join(project, `distractor-${index}.jsonl`),
        [
          claudeLine("user", "india 只是提一下。", "2026-11-12T00:00:00.000Z"),
          claudeLine("assistant", "继续观察。", "2026-11-12T00:00:01.000Z"),
          "",
        ].join("\n"),
      );
    }
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const result = searchSessions(db, `${targetTerms.join(" ")} india`, {
      limit: 5,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.tier, "focused");
    assert.equal(result.hits[0]?.sid, "target");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an OOV query reads matching human messages per candidate, not from one global window", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-oov-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const focusedText = "alpha github readme 私有仓库";
    const filler = Array.from({ length: 20 }, (_value, index) => `noise${index}`).join(" ");
    // More than the 128-row global fallback window, each matching only one
    // top-IDF term and failing the gate.
    for (let index = 0; index < 140; index += 1) {
      writeFileSync(
        join(project, `decoy-${String(index).padStart(3, "0")}.jsonl`),
        [
          JSON.stringify({
            type: "assistant",
            timestamp: "2026-11-12T00:00:00.000Z",
            cwd: "/home/dev",
            isSidechain: false,
            message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: { path: `${focusedText} ${filler}` } }] },
          }),
          claudeLine("user", "alpha 更新了。", "2026-11-12T00:00:01.000Z"),
          "",
        ].join("\n"),
      );
    }
    writeFileSync(
      join(project, "target.jsonl"),
      [
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-11-12T00:00:02.000Z",
          cwd: "/home/dev",
          isSidechain: false,
          message: {
            role: "assistant",
            content: [{ type: "tool_use", name: "Read", input: { path: focusedText } }],
          },
        }),
        claudeLine("user", "readme 和 github 都确认过了。", "2026-11-12T00:00:03.000Z"),
        claudeLine("assistant", "决定：两项都处理完了。", "2026-11-12T00:00:04.000Z"),
        "",
      ].join("\n"),
    );
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const result = searchSessions(db, "alpha-eemory github readme 私有仓库", {
      limit: 5,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.hits[0]?.sid, "target");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("project filter and excluded session ids are enforced", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-scope-"));
  try {
    const claudeRoot = join(directory, "claude");
    for (const projectName of ["-home-dev-a", "-home-dev-b"]) {
      const project = join(claudeRoot, projectName);
      mkdirSync(project, { recursive: true });
      writeFileSync(
        join(project, `${projectName}.jsonl`),
        [
          claudeLine("user", "cache 权限错误怎么修？", "2026-11-12T00:00:00.000Z"),
          claudeLine("assistant", "决定：补上 cache 权限。", "2026-11-12T00:00:01.000Z"),
          "",
        ].join("\n"),
      );
    }
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const all = searchSessions(db, "cache 权限", { limit: 5 });
    assert.equal(all.hits.length, 2);
    const scoped = searchSessions(db, "cache 权限", {
      limit: 5,
      project: "-home-dev-a",
    });
    assert.equal(scoped.hits.length, 1);
    assert.equal(scoped.hits[0]!.project, "-home-dev-a");
    const excluded = searchSessions(db, "cache 权限", {
      limit: 5,
      excludedSids: scoped.hits.map((hit) => hit.sid),
    });
    assert.equal(excluded.hits.length, 1);
    assert.equal(excluded.hits[0]!.project, "-home-dev-b");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stripQueryFrame drops conversational framing but keeps content labels", () => {
  assert.equal(stripQueryFrame("想确认一下：alpha beta gamma"), "alpha beta gamma");
  assert.equal(
    stripQueryFrame("同步 agent 配置时：alpha beta gamma"),
    "alpha beta gamma",
  );
  const contentLabel =
    "独立验证第 1 轮给出了修复清单：out/plan/paymentservice/verify-r1.json。请逐条处理。";
  assert.equal(stripQueryFrame(contentLabel), contentLabel);
  const scoped = "在 /home/dev/acme 项目里查：alpha beta gamma";
  assert.equal(stripQueryFrame(scoped), scoped);
  assert.equal(stripQueryFrame("失败时：重试三次"), "失败时：重试三次");
  assert.equal(stripQueryFrame("alpha beta gamma"), "alpha beta gamma");
});

test("normalizeQuery removes a path hint and a conversational frame", () => {
  const hinted = extractPathHint("alpha beta（相关路径：/home/dev/acme/src）");
  assert.equal(hinted.query, "alpha beta");
  assert.equal(hinted.path, "/home/dev/acme/src");
  assert.equal(normalizeQuery("想确认一下：alpha beta"), "alpha beta");
  assert.equal(
    normalizeQuery("想确认一下：alpha beta（相关路径：/home/dev/acme/src）"),
    "alpha beta",
  );
  assert.deepEqual(extractPathHint("alpha beta"), { query: "alpha beta", path: null });
});

test("repairs a same-length OOV typo from the corpus vocabulary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-oov-fix-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(
        join(project, `decoy-${index}.jsonl`),
        [
          claudeLine("user", "pgbouncer 配置怎么改？", "2026-11-12T00:00:00.000Z"),
          claudeLine("assistant", "决定：pgbouncer 已更新。", "2026-11-12T00:00:01.000Z"),
          "",
        ].join("\n"),
      );
    }
    writeFileSync(
      join(project, "target.jsonl"),
      [
        claudeLine("user", "pgbouncer 连接池 怎么配置？", "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "决定：pgbouncer 连接池已调大。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const result = searchSessions(db, "pgbounccr 连接池", {
      limit: 5,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.tier, "exact");
    assert.match(result.terms.join(" "), /pgbouncer/);
    assert.equal(result.hits[0]?.sid, "target");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repairs a misspelled path segment against the corpus vocabulary", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-pathfix-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "target.jsonl"),
      [
        claudeLine(
          "user",
          "修复清单：out/plan/paymentservice/verify-r1.json。请逐条处理。",
          "2026-11-12T00:00:00.000Z",
        ),
        claudeLine("assistant", "决定：清单已处理完。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(project, "decoy.jsonl"),
      [
        claudeLine(
          "user",
          "修复清单：out/plan/paymentserviceplus/verify-r2.json。请逐条处理。",
          "2026-11-12T00:00:00.000Z",
        ),
        claudeLine("assistant", "决定：另一份清单也处理了。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const result = searchSessions(db, "修复清单：out/plan/paymentservece/verify-r1.json。请逐条处理。", {
      limit: 5,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.tier, "exact");
    assert.ok(result.terms.includes("out/plan/paymentservice/verify-r1.json"));
    assert.equal(result.hits[0]?.sid, "target");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("repairs a transposed CJK run when the corpus has a common phrase", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-cjkfix-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "target.jsonl"),
      [
        claudeLine("user", "agy 默认模型 是什么", "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "决定：agy 当前默认模型是 Gemini 4 Argon。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(project, "decoy.jsonl"),
      [
        claudeLine("user", "agy 模型只是提一下。", "2026-11-12T00:00:00.000Z"),
        claudeLine("assistant", "继续观察。", "2026-11-12T00:00:01.000Z"),
        "",
      ].join("\n"),
    );
    // The CJK correction only accepts a phrase whose bigrams are common in the
    // corpus, so the fixture needs enough sessions carrying 默认模型.
    for (let index = 0; index < 25; index += 1) {
      writeFileSync(
        join(project, `cjk-filler-${index}.jsonl`),
        [
          claudeLine("user", "默认模型 的配置在哪里？", "2026-11-12T00:00:00.000Z"),
          claudeLine("assistant", "继续观察。", "2026-11-12T00:00:01.000Z"),
          "",
        ].join("\n"),
      );
    }
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const result = searchSessions(db, "agy 认默模型 星", {
      limit: 5,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.tier, "exact");
    assert.ok(result.terms.includes("默认"));
    assert.ok(result.terms.includes("认模"));
    assert.equal(result.hits[0]?.sid, "target");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a path hint boosts sessions that carry every path token", async () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-search-path-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const toolLine = (path: string): string =>
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-11-12T00:00:00.000Z",
        cwd: "/home/dev",
        isSidechain: false,
        message: {
          role: "assistant",
          content: [{ type: "tool_use", name: "Read", input: { path } }],
        },
      });
    writeFileSync(
      join(project, "a-plain.jsonl"),
      [
        toolLine("/workspace/other-topic/src2"),
        claudeLine("user", "alpha beta 怎么处理？", "2026-11-12T00:00:01.000Z"),
        claudeLine("assistant", "决定：alpha beta 已处理。", "2026-11-12T00:00:02.000Z"),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(project, "z-path.jsonl"),
      [
        toolLine("/workspace/rare-topic/src"),
        claudeLine("user", "alpha beta 怎么处理？", "2026-11-12T00:00:01.000Z"),
        claudeLine("assistant", "决定：alpha beta 已处理。", "2026-11-12T00:00:02.000Z"),
        "",
      ].join("\n"),
    );
    const dbPath = join(directory, "mem.db");
    await indexAll({
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
    const db = openDatabase(dbPath);
    const result = searchSessions(db, "alpha beta（相关路径：/workspace/rare-topic/src）", {
      limit: 5,
      now: new Date("2026-11-12T00:00:00.000Z"),
    });
    assert.equal(result.hits[0]?.sid, "z-path");
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
