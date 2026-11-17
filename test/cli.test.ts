import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

function claudeLine(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    type: role,
    timestamp: "2026-11-12T00:00:00.000Z",
    cwd: "/home/dev",
    isSidechain: false,
    message: { role, content: [{ type: "text", text }] },
  });
}

function runMem(
  args: string[],
  env: NodeJS.ProcessEnv,
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, ["bin/mem.js", ...args], {
    cwd: resolve("."),
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

test("CLI exposes index, search, recall, show, notes, ctx, stats, and doctor", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-cli-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const sid = "cli-session";
    writeFileSync(
      join(project, `${sid}.jsonl`),
      [
        claudeLine("user", "alpha beta 缓存权限怎么修？"),
        claudeLine("assistant", "决定：补上 alpha beta 的缓存权限。"),
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      MEM_DB: join(directory, "mem.db"),
      MEM_CLAUDE_ROOT: claudeRoot,
      MEM_CODEX_ROOT: join(directory, "empty-codex"),
      MEM_OPENCODE_DB: join(directory, "missing.db"),
      MEM_QODER_ROOT: join(directory, "empty-qoder"),
      MEM_PI_ROOT: join(directory, "empty-pi"),
      MEM_DSH_ROOT: join(directory, "empty-dsh"),
      MEM_ANTIGRAVITY_ROOT: join(directory, "empty-antigravity"),
      MEM_GLOBAL_NOTES: join(directory, "global.jsonl"),
      MEM_REPO_NOTES: join(directory, "repo.jsonl"),
    };

    const indexed = runMem(["index", "--quiet"], env);
    assert.equal(indexed.status, 0, indexed.stderr);

    const search = runMem(["search", "alpha beta", "--json", "--limit", "2"], env);
    assert.equal(search.status, 0, search.stderr);
    const payload = JSON.parse(search.stdout) as {
      hits: Array<{ sid: string }>;
    };
    assert.equal(payload.hits[0]?.sid, sid);

    const recall = runMem(["recall", "alpha beta"], env);
    assert.equal(recall.status, 0, recall.stderr);
    assert.ok(recall.stdout.trim().length > 0);

    const show = runMem(["show", sid], env);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /alpha beta/);

    const remembered = runMem(
      ["remember", "--repo", "alpha beta 的缓存权限必须保留"],
      env,
    );
    assert.equal(remembered.status, 0, remembered.stderr);
    const notes = runMem(["notes"], env);
    assert.equal(notes.status, 0, notes.stderr);
    assert.match(notes.stdout, /alpha beta/);

    for (const command of ["ctx", "stats", "doctor"]) {
      const result = runMem([command], env);
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotThrow(() => JSON.parse(result.stdout));
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a correction supersedes an active note, and only the new one stays visible", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-notes-"));
  try {
    const env = {
      ...process.env,
      MEM_DB: join(directory, "mem.db"),
      MEM_GLOBAL_NOTES: join(directory, "global.jsonl"),
      MEM_REPO_NOTES: join(directory, "repo.jsonl"),
    };

    const first = runMem(["remember", "gateway 必须用 0.1.2557"], env);
    assert.equal(first.status, 0, first.stderr);
    const oldId = (JSON.parse(first.stdout) as { saved: string }).saved;

    const correction = runMem(
      ["remember", "--supersedes", oldId, "gateway 升级到 0.1.3727"],
      env,
    );
    assert.equal(correction.status, 0, correction.stderr);
    const newId = (JSON.parse(correction.stdout) as { saved: string }).saved;
    assert.notEqual(newId, oldId);

    const active = runMem(["notes"], env);
    assert.equal(active.status, 0, active.stderr);
    assert.match(active.stdout, /0\.1\.3727/);
    assert.doesNotMatch(active.stdout, /0\.1\.2557/);
    assert.match(active.stdout, new RegExp(newId));
    assert.doesNotMatch(active.stdout, new RegExp(`^${oldId}\\t`, "m"));

    const history = runMem(["notes", "--all"], env);
    assert.equal(history.status, 0, history.stderr);
    assert.match(history.stdout, new RegExp(`^${oldId}\\tsuperseded\\t`, "m"));
    assert.match(history.stdout, new RegExp(`^${newId}\\tactive\\t`));
    assert.match(history.stdout, new RegExp(`^${newId}\\tactive\\t[^\\t]*\\t[^\\t]*\\t[^\\t]*\\thuman\\t${oldId}`, "m"));

    // A superseded note can never be superseded again: no ambiguous history.
    const repeat = runMem(["remember", "--supersedes", oldId, "又改一次"], env);
    assert.equal(repeat.status, 2);
    assert.match(repeat.stderr, /已不是 active/);

    const missing = runMem(["remember", "--supersedes", "no-such-id", "孤立纠错"], env);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /找不到要覆盖的笔记/);

    const forgotten = runMem(["forget", newId], env);
    assert.equal(forgotten.status, 0, forgotten.stderr);
    const afterForget = runMem(["notes"], env);
    assert.equal(afterForget.stdout.trim(), "");
    const archived = runMem(["notes", "--all"], env);
    assert.match(archived.stdout, new RegExp(`^${newId}\\tarchived\\t`, "m"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the recall block carries a full sid that mem show can resolve", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-trace-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const sid = "5f2c8a10-3d47-4e91-9b6e-2a7c4d8f1e30";
    writeFileSync(
      join(project, `${sid}.jsonl`),
      [
        claudeLine("user", "alpha beta 缓存权限怎么修？"),
        claudeLine("assistant", "决定：补上 alpha beta 的缓存权限。"),
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      MEM_DB: join(directory, "mem.db"),
      MEM_CLAUDE_ROOT: claudeRoot,
      MEM_CODEX_ROOT: join(directory, "empty-codex"),
      MEM_OPENCODE_DB: join(directory, "missing.db"),
      MEM_QODER_ROOT: join(directory, "empty-qoder"),
      MEM_PI_ROOT: join(directory, "empty-pi"),
      MEM_DSH_ROOT: join(directory, "empty-dsh"),
      MEM_ANTIGRAVITY_ROOT: join(directory, "empty-antigravity"),
      MEM_GLOBAL_NOTES: join(directory, "global.jsonl"),
      MEM_REPO_NOTES: join(directory, "repo.jsonl"),
    };
    assert.equal(runMem(["index", "--quiet"], env).status, 0);

    const recall = runMem(["recall", "alpha beta"], env);
    assert.equal(recall.status, 0, recall.stderr);
    assert.match(recall.stdout, new RegExp(`\`${sid}\``));

    const show = runMem(["show", sid], env);
    assert.equal(show.status, 0, show.stderr);
    assert.match(show.stdout, /alpha beta 缓存权限/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the recall block does not use a markdown heading as the conclusion", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-heading-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      join(project, "heading-session.jsonl"),
      [
        claudeLine("user", "alpha beta 缓存权限怎么修？"),
        claudeLine("assistant", "## 决定：修复 alpha beta 的缓存权限"),
        claudeLine("assistant", "决定：补上 alpha beta 的缓存权限。"),
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      MEM_DB: join(directory, "mem.db"),
      MEM_CLAUDE_ROOT: claudeRoot,
      MEM_CODEX_ROOT: join(directory, "empty-codex"),
      MEM_OPENCODE_DB: join(directory, "missing.db"),
      MEM_QODER_ROOT: join(directory, "empty-qoder"),
      MEM_PI_ROOT: join(directory, "empty-pi"),
      MEM_DSH_ROOT: join(directory, "empty-dsh"),
      MEM_ANTIGRAVITY_ROOT: join(directory, "empty-antigravity"),
      MEM_GLOBAL_NOTES: join(directory, "global.jsonl"),
      MEM_REPO_NOTES: join(directory, "repo.jsonl"),
    };
    assert.equal(runMem(["index", "--quiet"], env).status, 0);

    const recall = runMem(["recall", "alpha beta"], env);
    assert.equal(recall.status, 0, recall.stderr);
    assert.doesNotMatch(recall.stdout, /- 结论: #/);
    assert.match(recall.stdout, /- 结论: 决定：补上/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recall excludes the CLAUDE_CODE_SESSION_ID session by default", () => {
  const directory = mkdtempSync(join(tmpdir(), "agent-memory-current-"));
  try {
    const claudeRoot = join(directory, "claude");
    const project = join(claudeRoot, "-home-dev");
    mkdirSync(project, { recursive: true });
    const current = "11111111-1111-4111-8111-111111111111";
    const other = "22222222-2222-4222-8222-222222222222";
    writeFileSync(
      join(project, `${current}.jsonl`),
      [
        claudeLine("user", "alpha beta 缓存权限怎么修？"),
        claudeLine("assistant", "决定：补上 alpha beta 的缓存权限。"),
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(project, `${other}.jsonl`),
      [
        claudeLine("user", "gamma delta 部署配置怎么改？"),
        claudeLine("assistant", "决定：把 gamma delta 部署配置改成只读。"),
        "",
      ].join("\n"),
    );
    const env = {
      ...process.env,
      MEM_DB: join(directory, "mem.db"),
      MEM_CLAUDE_ROOT: claudeRoot,
      MEM_CODEX_ROOT: join(directory, "empty-codex"),
      MEM_OPENCODE_DB: join(directory, "missing.db"),
      MEM_QODER_ROOT: join(directory, "empty-qoder"),
      MEM_PI_ROOT: join(directory, "empty-pi"),
      MEM_DSH_ROOT: join(directory, "empty-dsh"),
      MEM_ANTIGRAVITY_ROOT: join(directory, "empty-antigravity"),
      MEM_GLOBAL_NOTES: join(directory, "global.jsonl"),
      MEM_REPO_NOTES: join(directory, "repo.jsonl"),
      CLAUDE_CODE_SESSION_ID: current,
    };
    assert.equal(runMem(["index", "--quiet"], env).status, 0);

    const excluded = runMem(["recall", "alpha beta"], env);
    assert.equal(excluded.status, 0, excluded.stderr);
    assert.equal(excluded.stdout.trim(), "");

    const recall = runMem(["recall", "gamma delta"], env);
    assert.equal(recall.status, 0, recall.stderr);
    assert.match(recall.stdout, new RegExp(other));
    assert.doesNotMatch(recall.stdout, new RegExp(current));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("recall excludes CODEX_SESSION_ID and OPENCODE_SESSION_ID by default", () => {
  for (const envName of ["CODEX_SESSION_ID", "OPENCODE_SESSION_ID"]) {
    const directory = mkdtempSync(join(tmpdir(), `agent-memory-${envName}-`));
    try {
      const claudeRoot = join(directory, "claude");
      const project = join(claudeRoot, "-home-dev");
      mkdirSync(project, { recursive: true });
      const sid = "33333333-3333-4333-8333-333333333333";
      writeFileSync(
        join(project, `${sid}.jsonl`),
        [
          claudeLine("user", "alpha beta 缓存权限怎么修？"),
          claudeLine("assistant", "决定：补上 alpha beta 的缓存权限。"),
          "",
        ].join("\n"),
      );
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        MEM_DB: join(directory, "mem.db"),
        MEM_CLAUDE_ROOT: claudeRoot,
        MEM_CODEX_ROOT: join(directory, "empty-codex"),
        MEM_OPENCODE_DB: join(directory, "missing.db"),
        MEM_QODER_ROOT: join(directory, "empty-qoder"),
        MEM_PI_ROOT: join(directory, "empty-pi"),
        MEM_DSH_ROOT: join(directory, "empty-dsh"),
        MEM_ANTIGRAVITY_ROOT: join(directory, "empty-antigravity"),
        MEM_GLOBAL_NOTES: join(directory, "global.jsonl"),
        MEM_REPO_NOTES: join(directory, "repo.jsonl"),
      };
      delete env.CLAUDE_CODE_SESSION_ID;
      delete env.MEM_CURRENT_SID;
      delete env.CODEX_SESSION_ID;
      delete env.OPENCODE_SESSION_ID;
      env[envName] = sid;

      assert.equal(runMem(["index", "--quiet"], env).status, 0);
      const recall = runMem(["recall", "alpha beta"], env);
      assert.equal(recall.status, 0, recall.stderr);
      assert.equal(recall.stdout.trim(), "");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
