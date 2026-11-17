import assert from "node:assert/strict";
import test from "node:test";

import {
  carriesTerm,
  queryParts,
  termHits,
  tokenize,
  windowSpan,
} from "../src/tokenize.js";

test("uses one CJK bigram vocabulary and drops stop characters", () => {
  assert.deepEqual(tokenize("报告的标题"), ["报告", "标题"]);
  assert.deepEqual(tokenize("acme 发版"), ["acme", "发版"]);
});

test("keeps the identifier and splits its internal words", () => {
  const tokens = tokenize("getUserProfile v2");
  assert.deepEqual(tokens, ["getuserprofile", "get", "user", "profile", "v2"]);
  assert.deepEqual(tokenize(".git"), ["git"]);
});

test("carriesTerm enforces short-token and long-token boundaries", () => {
  assert.equal(carriesTerm("acme-release", "acme"), true);
  assert.equal(carriesTerm("xacme", "acme"), false);
  assert.equal(carriesTerm("call getUserProfile now", "getuserprofile"), true);
  assert.equal(carriesTerm("xgetUserProfile", "getuserprofile"), false);
  assert.equal(carriesTerm("这是报告的标题", "报告"), true);
  assert.equal(carriesTerm("升级到 v0.1.3727", "0.1.3727"), true);
  assert.equal(carriesTerm("xv0.1.3727", "0.1.3727"), false);
});

test("termHits and windowSpan operate on the same normalized text", () => {
  assert.equal(termHits("Alpha beta alpha", ["alpha", "beta"]), 2);
  assert.equal(windowSpan("alpha foo beta alpha", ["alpha", "beta"]), 10);
});

test("queryParts extracts quoted phrases without losing query terms", () => {
  assert.deepEqual(queryParts('查询 "connection pool" timeout'), {
    terms: ["timeout", "connection", "pool", "查询"],
    phrases: ["connection pool"],
  });
});
