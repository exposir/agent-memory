import type Database from "better-sqlite3";

import { tokenize } from "../../src/tokenize.js";

export interface SessionSummary {
  sid: string;
  agent: "claude" | "codex" | "opencode";
  project: string;
  cwd: string | null;
  title: string | null;
  started: string | null;
  updated: string | null;
}

export function holderSids(db: Database.Database, queryTerms: string[]): string[] {
  const terms = [...new Set(queryTerms)];
  if (terms.length === 0) {
    return [];
  }

  const read = db.prepare("SELECT sid FROM postings WHERE term = ?");
  const sets = terms.map((term) => {
    const rows = read.all(term) as Array<{ sid: string }>;
    return new Set(rows.map((row) => row.sid));
  });
  sets.sort((left, right) => left.size - right.size);

  const first = sets[0]!;
  const candidates = [...first].filter((sid) => sets.every((set) => set.has(sid)));
  return candidates.map((sid) => {
    const score = db
      .prepare("SELECT count(*) AS n FROM postings WHERE sid = ? AND term IN (SELECT value FROM json_each(?))")
      .get(sid, JSON.stringify(terms)) as { n: number };
    return { sid, n: score.n };
  }).sort((left, right) => right.n - left.n || left.sid.localeCompare(right.sid)).map((row) => row.sid);
}

export function uniqueHolder(db: Database.Database, query: string): string | null {
  const holders = holderSids(db, tokenize(query));
  return holders.length === 1 ? holders[0]! : null;
}

export function getSession(db: Database.Database, sid: string): SessionSummary | null {
  const row = db
    .prepare(
      "SELECT sid, agent, project, cwd, title, started, updated FROM sessions WHERE sid = ?",
    )
    .get(sid) as SessionSummary | undefined;
  return row ?? null;
}
