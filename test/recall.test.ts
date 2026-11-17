import assert from "node:assert/strict";
import test from "node:test";

import {
  CONCLUSION_POLICY,
  buildRecall,
  conclusionPolicy,
  formatRecall,
  type RecallCandidate,
  type RecallMessage,
} from "../src/recall.js";

function message(ordinal: number, role: RecallMessage["role"], text: string): RecallMessage {
  return {
    ordinal,
    role,
    kind: role === "user" ? "UserMessage" : "AgentMessage",
    text,
    ts: `2026-11-12T00:00:${String(ordinal).padStart(2, "0")}.000Z`,
  };
}

function candidate(sid: string, messages: RecallMessage[], overrides: Partial<RecallCandidate> = {}): RecallCandidate {
  return {
    sid,
    agent: "codex",
    project: "/home/dev/project",
    updatedAt: "2026-11-12T00:00:00.000Z",
    messages,
    ...overrides,
  };
}

function basicCandidate(
  sid = "sid-basic",
  conclusion = "定位到根因：缓存里的二进制平台不对。",
  overrides: Partial<RecallCandidate> = {},
): RecallCandidate {
  return candidate(
    sid,
    [
      message(0, "user", "wrangler 报 workerd 权限错误，这个怎么修？"),
      message(1, "assistant", "我先检查一下环境。"),
      message(2, "assistant", "检查完了，下一步处理缓存。"),
      message(3, "assistant", "结果已经出来。"),
      message(4, "assistant", conclusion),
    ],
    overrides,
  );
}

test("builds two slots even when the conclusion does not repeat query terms", () => {
  const blocks = buildRecall("wrangler workerd 权限", [basicCandidate()]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.problem?.text ?? "", /wrangler/);
  assert.doesNotMatch(blocks[0]!.conclusion[0]!.text, /wrangler|workerd|权限/i);
});

test("replyWindow includes the fourth message and excludes the fifth", () => {
  const inside = candidate("sid-inside", [
    message(0, "user", "retry budget 应该怎么定？"),
    message(1, "assistant", "先看 retry budget 的现状。"),
    message(2, "assistant", "继续检查。"),
    message(3, "assistant", "还在检查。"),
    message(4, "assistant", "最后定下：retry budget 上限三次。"),
  ]);
  const outside = candidate("sid-outside", [
    message(0, "user", "retry budget 应该怎么定？"),
    message(1, "assistant", "先看现状。"),
    message(2, "assistant", "继续检查。"),
    message(3, "assistant", "还在检查。"),
    message(4, "assistant", "还没有结论。"),
    message(5, "assistant", "最后定下：retry budget 上限三次。"),
  ]);

  assert.equal(buildRecall("retry budget", [inside]).length, 1);
  assert.equal(buildRecall("retry budget", [outside]).length, 0);
});

test("tool records do not consume the user/assistant reply window", () => {
  const noisy = candidate("sid-tool-window", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "tool_call", "Read: auth.ts"),
    message(2, "tool_result", "permission denied"),
    message(3, "tool_call", "Bash: inspect cache"),
    message(4, "tool_result", "cache mode 0600"),
    message(5, "assistant", "决定：补上 cache 权限并重启。"),
  ]);
  assert.equal(buildRecall("cache 权限", [noisy]).length, 1);
});

test("uses a strong on-topic assistant line when no explicit decision marker exists", () => {
  const plain = candidate("sid-plain-conclusion", [
    message(0, "user", "alpha beta 现在是什么状态？"),
    message(1, "assistant", "alpha 已经完成部署，beta 保持只读。"),
  ]);
  const blocks = buildRecall("alpha beta", [plain]);
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.conclusion[0]!.text, /alpha/);
});

test("tries an earlier occurrence when a repeated prompt has no close answer", () => {
  const repeated = candidate("sid-repeated", [
    message(0, "user", "alpha beta 怎么处理？"),
    message(1, "assistant", "决定：alpha beta 采用增量方案。"),
    message(2, "assistant", "继续处理其他事项。"),
    message(3, "assistant", "又完成一个无关步骤。"),
    message(4, "assistant", "仍在继续。"),
    message(5, "user", "alpha beta 怎么处理？"),
    message(6, "assistant", "先看别的内容。"),
    message(7, "assistant", "继续看别的内容。"),
    message(8, "assistant", "还没有结论。"),
    message(9, "assistant", "等待下一步。"),
  ]);
  const blocks = buildRecall("alpha beta", [repeated]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.conclusion[0]!.ordinal, 1);
});

test("anchor terms reject a problem that only carries a weak overlap", () => {
  const weak = candidate("sid-anchor-weak", [
    message(0, "user", "pgbouncer 应该怎么调？"),
    message(1, "assistant", "决定：调大连接池。"),
  ]);
  assert.equal(
    buildRecall("pgbouncer alpha", [weak], {
      anchorTerms: ["pgbouncer", "alpha"],
      anchorNeed: 2,
    }).length,
    0,
  );
});

test("keeps conclusions in original session order", () => {
  const blocks = buildRecall("cache 权限", [
    candidate("sid-order", [
      message(0, "user", "cache 权限问题怎么修？"),
      message(1, "assistant", "结论：先确认账号权限。"),
      message(2, "assistant", "然后继续检查。"),
      message(3, "assistant", "决定：最后切换到新的 cache。"),
    ]),
  ]);
  assert.deepEqual(
    blocks[0]!.conclusion.map((quote) => quote.ordinal),
    [1, 3],
  );
});

test("skips harness self-tests", () => {
  const harness = basicCandidate("sid-harness");
  harness.messages.unshift(message(-1, "user", "harness live test alpha"));
  assert.equal(buildRecall("wrangler workerd 权限", [harness]).length, 0);
  assert.equal(buildRecall("wrangler workerd 权限", [basicCandidate("sid-normal")]).length, 1);
});

test("does not treat a long unrelated session with a deep self-test fixture as a harness test", () => {
  const mixed = candidate("sid-deep-harness", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "决定：补上 cache 权限。"),
    message(2, "user", "继续做别的。"),
    ...Array.from({ length: 8 }, (_value, index) =>
      message(3 + index, "assistant", `无关步骤 ${index + 1}。`),
    ),
    message(11, "user", "harness live test alpha"),
  ]);
  assert.equal(buildRecall("cache 权限", [mixed]).length, 1);
});

test("skips smoke tests that ask for a short token", () => {
  const smoke = candidate("sid-smoke", [
    message(0, "user", "只回复 token"),
    message(1, "assistant", "决定：OK"),
  ]);
  const substantive = candidate("sid-substantive", [
    message(0, "user", "只回复 token，另外请完整说明这次排障的结论。"),
    message(1, "assistant", "决定：把 token 过期时间延长到一小时，并补充自动刷新。"),
  ]);
  assert.equal(buildRecall("token 回复", [smoke]).length, 0);
  assert.equal(buildRecall("token 回复", [substantive]).length, 1);
});

test("skips sessions whose conclusions are all blocked", () => {
  const blocked = basicCandidate("sid-blocked", "决定：本轮无法继续，权限不足。");
  const mixed = candidate("sid-mixed", [
    message(0, "user", "wrangler workerd 权限错误怎么修？"),
    message(1, "assistant", "决定：直接访问被阻止，权限不足。"),
    message(2, "assistant", "最后改用隔离缓存，workerd 已经正常。"),
  ]);
  assert.equal(buildRecall("wrangler workerd 权限", [blocked]).length, 0);
  assert.equal(buildRecall("wrangler workerd 权限", [mixed]).length, 1);
});

test("skips the no-memory line", () => {
  const noMemory = basicCandidate("sid-no-memory", "结论：我没有相关记忆。");
  const memory = basicCandidate("sid-memory", "结论：缓存平台已经改为 Linux 版本。");
  assert.equal(buildRecall("wrangler workerd 权限", [noMemory]).length, 0);
  assert.equal(buildRecall("wrangler workerd 权限", [memory]).length, 1);
});

test("skips plumbing lines and tool records", () => {
  const plumbing = candidate("sid-plumbing", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "Output: 决定：已修复 cache 权限。"),
    message(2, "tool_result", "决定：已修复 cache 权限。"),
  ]);
  const clean = candidate("sid-clean", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "决定：已经补上 cache 权限并验证通过。"),
  ]);
  assert.equal(buildRecall("cache 权限", [plumbing]).length, 0);
  assert.equal(buildRecall("cache 权限", [clean]).length, 1);
});

test("skips a document that is only one bullet", () => {
  const bullet = candidate("sid-bullet", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "- 决定：切换到新的 cache。"),
  ]);
  const paragraph = candidate("sid-paragraph", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "这里已经决定：切换到新的 cache，权限问题解决。"),
  ]);
  assert.equal(buildRecall("cache 权限", [bullet]).length, 0);
  assert.equal(buildRecall("cache 权限", [paragraph]).length, 1);
});

test("skips near-duplicate sessions and keeps the first", () => {
  const first = basicCandidate("sid-first");
  const second = basicCandidate(
    "sid-second",
    "定位到根因：缓存里的二进制平台不对，已改为 Linux 版本。",
  );
  const blocks = buildRecall("wrangler workerd 权限", [first, second]);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.sid, "sid-first");
});

test("skips the current session and its lineage", () => {
  const current = basicCandidate("sid-current");
  const child = basicCandidate("sid-child", "决定：改为新协议。", {
    lineageSids: ["sid-current"],
  });
  const other = basicCandidate("sid-other", "决定：改为另一套缓存。");
  const blocks = buildRecall("wrangler workerd 权限", [current, child, other], {
    currentSid: "sid-current",
  });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]!.sid, "sid-other");
});

test("returns empty for an unrelated question", () => {
  assert.equal(buildRecall("红烧肉 八角", [basicCandidate()]).length, 0);
});

test("applies the candidate-count conclusion policy", () => {
  assert.deepEqual(conclusionPolicy(1), CONCLUSION_POLICY.one);
  assert.deepEqual(conclusionPolicy(2), CONCLUSION_POLICY.two);
  assert.deepEqual(conclusionPolicy(3), CONCLUSION_POLICY.many);

  const fourConclusions = candidate("sid-four", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "结论：先查账号。"),
    message(2, "assistant", "决定：补 ACL。"),
    message(3, "assistant", "修复了：缓存读取。"),
    message(4, "assistant", "已解决：权限报错。"),
  ]);
  const blocks = buildRecall("cache 权限", [fourConclusions], { maxBytes: 10_000 });
  assert.equal(blocks[0]!.conclusion.length, 4);
});

test("keeps the full session id so a recall block can be traced back", () => {
  const sid = "5f2c8a10-3d47-4e91-9b6e-2a7c4d8f1e30";
  const blocks = buildRecall("cache 权限", [
    basicCandidate(sid, "决定：补上 cache 权限。"),
  ]);
  const output = formatRecall(blocks);
  assert.match(output, new RegExp(sid));
  assert.doesNotMatch(output, /`5f2c8a10-3d47`/);
  assert.doesNotMatch(output, /`[^`]{12}`/);
});

test("formats the block date from the conclusion message, not the session update", () => {
  const conclusion = {
    ...message(1, "assistant", "决定：补上 cache 权限。"),
    ts: "2026-11-10T04:08:38.507Z",
  };
  const session = candidate(
    "sid-date",
    [message(0, "user", "cache 权限怎么修？"), conclusion],
    { updatedAt: "2026-11-12T03:19:04.019Z" },
  );
  const output = formatRecall(buildRecall("cache 权限", [session]));
  assert.match(output, /· 2026-11-10/);
  assert.doesNotMatch(output, /· 2026-11-12/);
});

test("skips a markdown heading that carries a decision marker", () => {
  const session = candidate("sid-heading", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "## 决定：修复 cache 权限\n先查看 cache 权限的状态。"),
  ]);
  const blocks = buildRecall("cache 权限", [session], { maxBytes: 10_000 });
  assert.equal(blocks.length, 1);
  assert.doesNotMatch(blocks[0]!.conclusion[0]!.text, /^#/);
  assert.match(blocks[0]!.conclusion[0]!.text, /状态/);
});

test("prefers a prose decision over a heading with the same marker", () => {
  const session = candidate("sid-heading-prose", [
    message(0, "user", "retry budget 应该怎么定？"),
    message(1, "assistant", "## 最后定下 retry budget\n最后定下：retry budget 上限三次。"),
  ]);
  const blocks = buildRecall("retry budget", [session], { maxBytes: 10_000 });
  assert.equal(blocks.length, 1);
  assert.match(blocks[0]!.conclusion[0]!.text, /上限三次/);
});

test("drops a conclusion slot that is only a markdown heading", () => {
  const session = candidate("sid-heading-only", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "## 决定：修复 cache 权限"),
  ]);
  assert.equal(buildRecall("cache 权限", [session]).length, 0);
});

test("fallback matching ignores a heading even without a decision marker", () => {
  const session = candidate("sid-heading-fallback", [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "## cache 权限修复说明\n补上 cache 权限后恢复正常。"),
  ]);
  const blocks = buildRecall("cache 权限", [session], { maxBytes: 10_000 });
  assert.equal(blocks.length, 1);
  assert.doesNotMatch(blocks[0]!.conclusion[0]!.text, /^#/);
  assert.match(blocks[0]!.conclusion[0]!.text, /恢复正常/);
});

test("removes evidence before touching conclusions", () => {
  const messages: RecallMessage[] = [
    message(0, "user", "cache 权限问题怎么修？"),
    message(1, "assistant", "cache 权限 当前状态：只读。"),
    message(2, "assistant", "cache 权限 证据：日志里是 403。"),
    message(3, "assistant", "决定：补上 cache 权限。"),
  ];
  const blocks = buildRecall("cache 权限", [candidate("sid-budget", messages)], {
    maxBytes: 260,
  });
  const output = formatRecall(blocks);
  assert.ok(Buffer.byteLength(output, "utf8") <= 260);
  assert.ok(blocks[0]!.conclusion.length > 0);
  assert.ok(blocks[0]!.evidence.length < 2);
});
