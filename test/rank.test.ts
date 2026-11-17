import assert from "node:assert/strict";
import test from "node:test";

import {
  BM25_B,
  BM25_DELTA,
  BM25_K1,
  DECISION_BOOST,
  DIRECT_BOOST,
  GAVE_UP_PENALTY,
  PASTE_PENALTY,
  PROMOTED_NOTE_BOOST,
  USER_ROLE_BOOST,
  bm25Score,
  freshnessDecay,
  hasIdentifierTerm,
  inverseDocumentFrequency,
  leadTermsMeet,
  looksPasted,
  onlyPastedLeadEvidence,
  proximityBoost,
  scoreDocument,
  titleBoost,
  wornBoost,
  worthShowing,
  type RankDocument,
} from "../src/rank.js";

function rankDocument(overrides: Partial<RankDocument> = {}): RankDocument {
  return {
    sid: "sid",
    agent: "codex",
    project: "/home/dev",
    title: "fixture",
    updatedAt: "2026-11-12T00:00:00.000Z",
    length: 10,
    termFrequencies: [
      { term: "alpha", tf: 1, userTf: 0, df: 1 },
      { term: "beta", tf: 0, userTf: 0, df: 2 },
    ],
    matched: 1,
    strong: 1,
    naming: 1,
    minWindow: 100,
    titleHits: 1,
    decided: false,
    pastedEvidence: false,
    directQuestion: false,
    gaveUp: false,
    promotedNote: false,
    recallCount: 0,
    humanMessages: [],
    ...overrides,
  };
}

test("BM25 constants and formula match the specification", () => {
  assert.equal(BM25_K1, 1.2);
  assert.equal(BM25_B, 0.75);
  assert.equal(BM25_DELTA, 0.1);
  assert.equal(USER_ROLE_BOOST, 1.3);
  const doc = rankDocument();
  const context = {
    corpusDocuments: 10,
    averageLength: 10,
    now: new Date("2026-11-12T00:00:00.000Z"),
    queryTerms: ["alpha"],
  };
  assert.equal(
    bm25Score(doc, context),
    inverseDocumentFrequency(1, 10) * (1 + BM25_DELTA),
  );

  doc.termFrequencies[0]!.userTf = 1;
  assert.equal(
    bm25Score(doc, context),
    inverseDocumentFrequency(1, 10) * (1 + BM25_DELTA) +
      inverseDocumentFrequency(1, 10) * (USER_ROLE_BOOST - 1),
  );
});

test("all ranking multipliers are present", () => {
  const now = new Date("2026-11-12T00:00:00.000Z");
  const breakdown = scoreDocument(
    rankDocument({
      decided: true,
      pastedEvidence: true,
      directQuestion: true,
      gaveUp: true,
      recallCount: 3,
      promotedNote: true,
    }),
    { corpusDocuments: 10, averageLength: 10, now, queryTerms: ["alpha", "beta"] },
  );
  assert.equal(breakdown.decision, DECISION_BOOST);
  assert.equal(breakdown.paste, 1);
  assert.equal(breakdown.gaveUp, 1);
  assert.equal(breakdown.freshness, 1);
  assert.equal(breakdown.proximity, proximityBoost(100, 2));
  assert.equal(breakdown.title, titleBoost(1, 2));
  assert.equal(breakdown.worn, wornBoost(3));
  assert.equal(breakdown.note, PROMOTED_NOTE_BOOST);
  assert.equal(breakdown.direct, DIRECT_BOOST);
  assert.ok(breakdown.score > breakdown.bm25);
});

test("paste penalty applies only when pasted evidence has no conclusion", () => {
  const context = {
    corpusDocuments: 10,
    averageLength: 10,
    now: new Date("2026-11-12T00:00:00.000Z"),
    queryTerms: ["alpha"],
  };
  assert.equal(
    scoreDocument(rankDocument({ pastedEvidence: true }), context).paste,
    PASTE_PENALTY,
  );
  assert.equal(
    scoreDocument(rankDocument({ pastedEvidence: true, decided: true }), context).paste,
    1,
  );
});

test("looksPasted requires eight low-diversity lines", () => {
  assert.equal(looksPasted("alpha\nbeta\ngamma"), false);
  assert.equal(looksPasted(Array.from({ length: 8 }, (_v, i) => `line ${i}`).join("\n")), false);
  const repeated = Array.from({ length: 8 }, () => "same line").join("\n");
  assert.equal(looksPasted(repeated), true);
});

test("only pasted messages carrying lead terms count as pasted evidence", () => {
  const repeated = Array.from({ length: 8 }, () => "alpha beta same line").join("\n");
  const normal = "alpha beta 怎么处理？";
  assert.equal(onlyPastedLeadEvidence([normal], ["alpha"]), false);
  assert.equal(onlyPastedLeadEvidence([repeated], ["alpha"]), true);
  assert.equal(onlyPastedLeadEvidence([repeated, normal], ["alpha"]), false);
  assert.equal(onlyPastedLeadEvidence([repeated], ["gamma"]), false);
});

test("gaveUp is reported for recall but does not demote search score", () => {
  const now = new Date("2026-11-12T00:00:00.000Z");
  const context = {
    corpusDocuments: 10,
    averageLength: 10,
    now,
    queryTerms: ["alpha"],
  };
  const settled = scoreDocument(rankDocument({ gaveUp: false }), context);
  const abandoned = scoreDocument(rankDocument({ gaveUp: true }), context);
  assert.equal(abandoned.gaveUp, GAVE_UP_PENALTY);
  assert.equal(abandoned.score, settled.score);
});

test("freshness, worn, proximity, and title helpers use documented bounds", () => {
  assert.equal(freshnessDecay(null, new Date()), 1);
  assert.equal(freshnessDecay("not-a-date", new Date()), 1);
  assert.equal(freshnessDecay("2026-11-12T00:00:00.000Z", new Date("2026-11-12T00:00:00.000Z")), 1);
  assert.equal(wornBoost(100), 1.5);
  assert.equal(proximityBoost(0, 2), 1);
  assert.equal(titleBoost(0, 2), 1);
});

test("titleBoost follows the presence of a real title, not the agent name", () => {
  const now = new Date("2026-11-12T00:00:00.000Z");
  const context = {
    corpusDocuments: 10,
    averageLength: 10,
    now,
    queryTerms: ["alpha", "beta"],
  };
  const claudeTitled = scoreDocument(rankDocument({ agent: "claude" }), context);
  const codexUntitled = scoreDocument(rankDocument({ title: null }), context);
  assert.equal(claudeTitled.title, titleBoost(1, 2));
  assert.equal(codexUntitled.title, 1);
});

test("worthShowing and leadTermsMeet apply naming and human-speech gates", () => {
  const idf = new Map([
    ["wrangler", 6],
    ["workerd", 5],
    ["权限", 2],
  ]);
  assert.equal(hasIdentifierTerm(["wrangler", "workerd"], idf), true);
  const doc = rankDocument({
    matched: 3,
    strong: 2,
    naming: 2,
    humanMessages: ["wrangler workerd 权限错误，准备修。"],
  });
  assert.equal(worthShowing(doc, ["wrangler", "workerd", "权限"], idf), true);
  assert.equal(leadTermsMeet(doc, ["wrangler", "workerd", "权限"], idf), true);

  doc.humanMessages = ["wrangler 这边有问题。", "workerd 那边也有问题。"];
  assert.equal(leadTermsMeet(doc, ["wrangler", "workerd", "权限"], idf), true);

  const common = rankDocument({ matched: 1, naming: 0 });
  assert.equal(worthShowing(common, ["cache", "权限"], new Map()), false);
  assert.equal(
    leadTermsMeet(
      rankDocument({
        matched: 2,
        naming: 0,
        humanMessages: ["cache 有问题。", "权限 也有问题。"],
      }),
      ["cache", "权限"],
      new Map([
        ["cache", 2],
        ["权限", 2],
      ]),
    ),
    false,
  );
});

test("leadTermsMeet requires human or project evidence for plain naming terms", () => {
  const idf = new Map([
    ["supersedes", 4.7],
    ["旧条", 4.04],
    ["记纠", 6.31],
  ]);
  const toolOnly = rankDocument({
    matched: 3,
    naming: 2,
    humanMessages: ["这里有些记录。"],
  });
  assert.equal(leadTermsMeet(toolOnly, ["supersedes", "笔记", "旧条"], idf), false);

  const spoken = rankDocument({
    matched: 3,
    naming: 2,
    humanMessages: ["supersedes 这个操作怎么理解？"],
  });
  assert.equal(leadTermsMeet(spoken, ["supersedes", "笔记", "旧条"], idf), true);

  const identifier = rankDocument({
    matched: 3,
    naming: 1,
    humanMessages: ["这个版本有问题。"],
  });
  assert.equal(
    leadTermsMeet(identifier, ["0.165", "版本"], new Map([["0.165", 5], ["版本", 2]])),
    true,
  );
});
