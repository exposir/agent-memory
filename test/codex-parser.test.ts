import assert from "node:assert/strict";
import test from "node:test";

import { parseCodexLine } from "../src/parsers/codex.js";

test("parses modern item_completed UserMessage with lowercase text", () => {
  const line = JSON.stringify({
    timestamp: "2026-11-12T06:38:39.355Z",
    ordinal: 8,
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: {
        type: "UserMessage",
        id: "msg-1",
        content: [{ type: "text", text: "修复 Codex 会话导入" }],
      },
    },
  });

  const event = parseCodexLine(line, "sid-1");
  assert.equal(event?.type, "message");
  if (event?.type !== "message") {
    return;
  }
  assert.equal(event.value.role, "user");
  assert.equal(event.value.kind, "UserMessage");
  assert.equal(event.value.text, "修复 Codex 会话导入");
});

test("accepts legacy uppercase Text blocks", () => {
  const line = JSON.stringify({
    type: "event_msg",
    payload: {
      type: "item_completed",
      item: { type: "UserMessage", content: [{ type: "Text", text: "legacy prompt" }] },
    },
  });

  const event = parseCodexLine(line, "sid-2");
  assert.equal(event?.type === "message" ? event.value.text : null, "legacy prompt");
});

test("ignores response_item user copies that contain developer context", () => {
  const line = JSON.stringify({
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "<environment_context>...</environment_context>" }],
    },
  });

  assert.equal(parseCodexLine(line, "sid-3"), null);
});
