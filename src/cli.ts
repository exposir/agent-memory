import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import Database from "better-sqlite3";

import {
  databasePath,
  getMeta,
  openDatabase,
  openReadDatabase,
  saveNote,
} from "./db.js";
import { exportAll } from "./export.js";
import { indexAll } from "./index.js";
import {
  buildRecall,
  formatRecall,
  type RecallCandidate,
  type RecallMessage,
} from "./recall.js";
import { redact } from "./redact.js";
import { restoreAll } from "./restore.js";
import { inverseDocumentFrequency, isNamingTerm, topLeadTerms } from "./rank.js";
import { normalizeQuery, searchSessions, type SearchResult } from "./search.js";
import type { AgentName, MessageRole, Note } from "./types.js";

const COMMANDS = [
  "index",
  "recall",
  "search",
  "ctx",
  "show",
  "remember",
  "forget",
  "notes",
  "doctor",
  "stats",
  "export",
  "restore",
] as const;

type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command | null;
  flags: Set<string>;
  options: Map<string, string>;
  positionals: string[];
}

interface SessionRow {
  id: string;
  agent: AgentName;
  project: string | null;
  cwd: string | null;
  title: string | null;
  path: string | null;
  started_at: string | null;
  updated_at: string | null;
  settled: number;
  gave_up: number;
  pasted: number;
  words: number;
}

const VALUE_FLAGS = new Set([
  "--limit",
  "--project",
  "--current-sid",
  "--exclude",
  "--db",
  "--supersedes",
  "--out",
  "--from",
]);

function usage(): string {
  return [
    "agent-memory",
    "",
    "用法:",
    "  mem <command> [options]",
    "",
    "命令:",
    "  index [--quiet]             建或增量更新本地索引",
    "  recall <查询> [--aggressive] 输出有界记忆块",
    "  search <查询> [--json]       列出相关会话",
    "  ctx                         当前上下文摘要",
    "  show <sid>                  查看会话原始消息",
    "  remember [--repo] <内容>     写显式笔记（--supersedes <id> 纠错）",
    "  forget <id>                 归档一条笔记",
    "  notes [--all]               列出笔记（默认仅 active）",
    "  doctor                      检查索引健康",
    "  stats                       输出索引统计",
    "  export --out <dir>          导出会话为 JSONL 快照（--force 覆盖）",
    "  restore --from <dir>        从 JSONL 快照还原索引",
    "",
    "通用选项:",
    "  --db <path>                 指定 MEM_DB 路径",
    "  --limit <n>                 search/recall 候选数",
    "  --project <name>            限定项目",
    "  --current-sid <sid>         排除当前会话",
    "  --exclude <sid[,sid]>       排除会话",
    "  --supersedes <id>           remember 覆盖的旧笔记 id",
  ].join("\n");
}

function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positionals: string[] = [];
  let command: Command | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (index === 0 && COMMANDS.includes(token as Command)) {
      command = token as Command;
      continue;
    }
    if (token.startsWith("--")) {
      const equals = token.indexOf("=");
      if (equals > 0) {
        options.set(token.slice(0, equals), token.slice(equals + 1));
        continue;
      }
      if (VALUE_FLAGS.has(token)) {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new Error(`${token} 需要一个值`);
        }
        options.set(token, value);
        index += 1;
        continue;
      }
      flags.add(token);
      continue;
    }
    positionals.push(token);
  }

  return { command, flags, options, positionals };
}

function dbPathFrom(args: ParsedArgs): string {
  return resolve(
    (args.options.get("--db") ?? databasePath()).replace(/^~(?=$|\/)/, homedir()),
  );
}

function requireDatabase(path: string): Database.Database {
  if (!existsSync(path)) {
    throw new Error(`索引不存在: ${path}\n先运行 mem index`);
  }
  return openReadDatabase(path);
}

function excludedSids(args: ParsedArgs): string[] {
  const fromOption = args.options.get("--exclude");
  const fromEnv = process.env.MEM_EXCLUDED_SIDS;
  return [
    ...(fromOption?.split(",") ?? []),
    ...(fromEnv?.split(",") ?? []),
  ]
    .map((sid) => sid.trim())
    .filter(Boolean);
}

function currentSid(args: ParsedArgs): string | undefined {
  return (
    args.options.get("--current-sid") ??
    process.env.MEM_CURRENT_SID ??
    process.env.CLAUDE_CODE_SESSION_ID ??
    process.env.CODEX_SESSION_ID ??
    process.env.OPENCODE_SESSION_ID
  );
}

function projectFilter(args: ParsedArgs): string | undefined {
  return args.options.get("--project") ?? process.env.MEM_PROJECT;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sessionByPrefix(
  db: Database.Database,
  prefix: string,
): SessionRow[] {
  const exact = db
    .prepare(
      `SELECT id, agent, project, cwd, title, path, started_at, updated_at,
              settled, gave_up, pasted, words
       FROM sessions WHERE id = ?`,
    )
    .get(prefix) as SessionRow | undefined;
  if (exact) {
    return [exact];
  }
  return db
    .prepare(
      `SELECT id, agent, project, cwd, title, path, started_at, updated_at,
              settled, gave_up, pasted, words
       FROM sessions
       WHERE id LIKE ? OR title LIKE ?
       ORDER BY updated_at DESC LIMIT 20`,
    )
    .all(`${prefix}%`, `%${prefix}%`) as SessionRow[];
}

function sessionMessages(
  db: Database.Database,
  sid: string,
): RecallMessage[] {
  const rows = db
    .prepare(
      `SELECT id, ordinal, ts, role, kind, text
       FROM msgs WHERE sid = ? ORDER BY ordinal`,
    )
    .all(sid) as Array<RecallMessage & { id: number }>;
  // Tool records are never read by recall; only pay for human token rows.
  const tokenRows = db
    .prepare(
      `SELECT m.id AS id, f.utokens AS utokens
       FROM msgs m JOIN msgs_fts f ON f.rowid = m.id
       WHERE m.sid = ? AND m.role IN ('user', 'assistant')`,
    )
    .all(sid) as Array<{ id: number; utokens: string }>;
  const tokensById = new Map(
    tokenRows.map((row) => [row.id, row.utokens ? row.utokens.split(" ") : []]),
  );
  for (const row of rows) {
    const tokens = tokensById.get(row.id);
    if (tokens && tokens.length > 0) {
      row.tokens = tokens;
    }
  }
  return rows;
}

function recallCandidates(
  db: Database.Database,
  result: SearchResult,
  limit: number,
): RecallCandidate[] {
  return result.hits.slice(0, limit).map((hit) => ({
    sid: hit.sid,
    agent: hit.agent,
    project: hit.project,
    updatedAt: hit.updatedAt,
    messages: sessionMessages(db, hit.sid),
  }));
}

function recallAnchors(
  db: Database.Database,
  terms: string[],
): { anchorTerms: string[]; anchorNeed: number } {
  if (terms.length === 0) {
    return { anchorTerms: [], anchorNeed: 0 };
  }
  const corpus = db.prepare("SELECT count(*) AS n FROM sessions").get() as {
    n: number;
  };
  const rows = db
    .prepare(
      `SELECT term, count(*) AS df FROM session_terms
       WHERE term IN (SELECT value FROM json_each(?))
       GROUP BY term`,
    )
    .all(JSON.stringify(terms)) as Array<{ term: string; df: number }>;
  const byTerm = new Map(rows.map((row) => [row.term, row.df]));
  const idfOf = new Map(
    terms.map((term) => {
      const df = byTerm.get(term) ?? 0;
      return [term, df > 0 ? inverseDocumentFrequency(df, corpus.n) : 0];
    }),
  );
  const known = terms.filter((term) => (byTerm.get(term) ?? 0) > 0);
  const named = known.filter((term) =>
    isNamingTerm(term, idfOf.get(term) ?? 0),
  );
  const selected = topLeadTerms(named.length > 0 ? named : known, idfOf).slice(
    0,
    2,
  );
  return {
    anchorTerms: selected,
    anchorNeed: selected.length > 0 ? 1 : 0,
  };
}

function searchOutput(result: SearchResult): string {
  if (result.hits.length === 0) {
    return "";
  }
  const lines = result.hits.map((hit, index) => {
    const date = hit.updatedAt?.slice(0, 10) ?? "无时间";
    const project = hit.project ?? "unknown";
    const title = hit.title ? ` ${hit.title.slice(0, 120)}` : "";
    return `${index + 1}. ${hit.sid}  ${hit.agent}  ${date}  ${project}${title}`;
  });
  return `${lines.join("\n")}\n`;
}

function databaseSummary(db: Database.Database, path: string): Record<string, unknown> {
  const counts = db
    .prepare(
      `SELECT
         (SELECT count(*) FROM sessions) AS sessions,
         (SELECT count(*) FROM msgs) AS messages,
         (SELECT count(*) FROM files) AS files,
         (SELECT count(*) FROM notes WHERE state = 'active') AS notes`,
    )
    .get() as {
    sessions: number;
    messages: number;
    files: number;
    notes: number;
  };
  const agents = db
    .prepare("SELECT agent, count(*) AS n FROM sessions GROUP BY agent ORDER BY agent")
    .all() as Array<{ agent: string; n: number }>;
  const roles = db
    .prepare("SELECT role, count(*) AS n FROM msgs GROUP BY role ORDER BY role")
    .all() as Array<{ role: string; n: number }>;
  return {
    db: path,
    bytes: existsSync(path) ? statSync(path).size : 0,
    indexedAt: getMeta(db, "indexed_at"),
    sessions: counts.sessions,
    messages: counts.messages,
    files: counts.files,
    activeNotes: counts.notes,
    agents: Object.fromEntries(agents.map((row) => [row.agent, row.n])),
    roles: Object.fromEntries(roles.map((row) => [row.role, row.n])),
  };
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function notesFilePath(repo: boolean): string {
  if (repo) {
    return process.env.MEM_REPO_NOTES
      ? resolve(process.env.MEM_REPO_NOTES.replace(/^~(?=$|\/)/, homedir()))
      : resolve(process.cwd(), ".mem", "notes.jsonl");
  }
  return process.env.MEM_GLOBAL_NOTES
    ? resolve(process.env.MEM_GLOBAL_NOTES.replace(/^~(?=$|\/)/, homedir()))
    : resolve(homedir(), ".local", "share", "mem", "notes.jsonl");
}

async function runIndex(args: ParsedArgs): Promise<void> {
  const stats = await indexAll({
    dbPath: dbPathFrom(args),
    quiet: args.flags.has("--quiet"),
    roots: {
      ...(process.env.MEM_CLAUDE_ROOT ? { claude: process.env.MEM_CLAUDE_ROOT } : {}),
      ...(process.env.MEM_CODEX_ROOT ? { codex: process.env.MEM_CODEX_ROOT } : {}),
      ...(process.env.MEM_OPENCODE_DB ? { opencode: process.env.MEM_OPENCODE_DB } : {}),
      ...(process.env.MEM_QODER_ROOT ? { qoder: process.env.MEM_QODER_ROOT } : {}),
      ...(process.env.MEM_PI_ROOT ? { pi: process.env.MEM_PI_ROOT } : {}),
      ...(process.env.MEM_DSH_ROOT ? { dsh: process.env.MEM_DSH_ROOT } : {}),
      ...(process.env.MEM_ANTIGRAVITY_ROOT
        ? { antigravity: process.env.MEM_ANTIGRAVITY_ROOT }
        : {}),
    },
  });
  if (!args.flags.has("--quiet")) {
    printJson(stats);
  }
  if (stats.errors.length > 0) {
    throw new Error(stats.errors.join("\n"));
  }
}

function runSearch(args: ParsedArgs): void {
  const query = args.positionals.join(" ").trim();
  if (!query) {
    throw new Error("mem search 需要查询内容");
  }
  const dbPath = dbPathFrom(args);
  const db = requireDatabase(dbPath);
  try {
    const project = projectFilter(args);
    const sid = currentSid(args);
    const result = searchSessions(db, query, {
      limit: positiveInteger(args.options.get("--limit"), 15),
      excludedSids: excludedSids(args),
      ...(project !== undefined ? { project } : {}),
      ...(sid !== undefined ? { currentSid: sid } : {}),
    });
    if (args.flags.has("--json")) {
      printJson(result);
    } else {
      process.stdout.write(searchOutput(result));
    }
  } finally {
    db.close();
  }
}

function runRecall(args: ParsedArgs): void {
  const query = args.positionals.join(" ").trim();
  if (!query) {
    throw new Error("mem recall 需要查询内容");
  }
  const aggressive = args.flags.has("--aggressive");
  const dbPath = dbPathFrom(args);
  const db = requireDatabase(dbPath);
  try {
    const candidateLimit = aggressive ? 12 : 8;
    const project = projectFilter(args);
    const sid = currentSid(args);
    const recallQuery = normalizeQuery(query);
    const result = searchSessions(db, recallQuery, {
      limit: candidateLimit,
      excludedSids: excludedSids(args),
      ...(project !== undefined ? { project } : {}),
      ...(sid !== undefined ? { currentSid: sid } : {}),
    });
    const candidates = recallCandidates(
      db,
      result,
      positiveInteger(
        args.options.get("--limit"),
        aggressive ? 6 : 3,
      ),
    );
    const anchors = recallAnchors(db, result.terms);
    const blocks = buildRecall(recallQuery, candidates, {
      aggressive,
      excludedSids: excludedSids(args),
      anchorTerms: anchors.anchorTerms,
      anchorNeed: anchors.anchorNeed,
      ...(sid !== undefined ? { currentSid: sid } : {}),
    });
    const output = formatRecall(blocks);
    if (output) {
      process.stdout.write(`${output}\n`);
    }
  } finally {
    db.close();
  }
}

function runCtx(args: ParsedArgs): void {
  const dbPath = dbPathFrom(args);
  const db = requireDatabase(dbPath);
  try {
    const recent = db
      .prepare(
        `SELECT id, agent, project, title, updated_at
         FROM sessions WHERE cwd = ? OR project = ?
         ORDER BY updated_at DESC LIMIT 5`,
      )
      .all(process.cwd(), process.cwd()) as Array<{
      id: string;
      agent: string;
      project: string | null;
      title: string | null;
      updated_at: string | null;
    }>;
    printJson({
      cwd: process.cwd(),
      db: dbPath,
      indexedAt: getMeta(db, "indexed_at"),
      recent,
    });
  } finally {
    db.close();
  }
}

function runShow(args: ParsedArgs): void {
  const prefix = args.positionals.join(" ").trim();
  if (!prefix) {
    throw new Error("mem show 需要 session id 或标题片段");
  }
  const dbPath = dbPathFrom(args);
  const db = requireDatabase(dbPath);
  try {
    const sessions = sessionByPrefix(db, prefix);
    if (sessions.length === 0) {
      throw new Error(`找不到会话: ${prefix}`);
    }
    if (sessions.length > 1 && !sessions.some((session) => session.id === prefix)) {
      throw new Error(
        `会话前缀不唯一:\n${sessions
          .slice(0, 10)
          .map((session) => `${session.id}\t${session.title ?? ""}`)
          .join("\n")}`,
      );
    }
    const session = sessions.find((item) => item.id === prefix) ?? sessions[0]!;
    const messages = db
      .prepare(
        `SELECT ordinal, ts, role, text FROM msgs
         WHERE sid = ? ORDER BY ordinal`,
      )
      .all(session.id) as Array<{
      ordinal: number;
      ts: string | null;
      role: MessageRole;
      text: string;
    }>;
    const lines = [
      `sid: ${session.id}`,
      `agent: ${session.agent}`,
      `project: ${session.project ?? ""}`,
      `cwd: ${session.cwd ?? ""}`,
      `title: ${session.title ?? ""}`,
      `updated: ${session.updated_at ?? ""}`,
      `messages: ${messages.length}`,
      "",
      ...messages.map(
        (message) =>
          `[${message.ordinal}] ${message.role}${message.ts ? ` ${message.ts}` : ""}\n${message.text}`,
      ),
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
  } finally {
    db.close();
  }
}

function runRemember(args: ParsedArgs): void {
  const text = redact(args.positionals.join(" ").trim());
  if (!text) {
    throw new Error("mem remember 需要笔记内容");
  }
  const repo = args.flags.has("--repo");
  const path = notesFilePath(repo);
  const dbPath = dbPathFrom(args);
  const db = openDatabase(dbPath);
  try {
    const supersedes = args.options.get("--supersedes") ?? null;
    if (supersedes) {
      const existing = db
        .prepare("SELECT id, state FROM notes WHERE id = ?")
        .get(supersedes) as { id: string; state: string } | undefined;
      if (!existing) {
        throw new Error(`找不到要覆盖的笔记: ${supersedes}`);
      }
      if (existing.state !== "active") {
        throw new Error(`笔记 ${supersedes} 已不是 active，不能重复覆盖`);
      }
    }
    const note: Note = {
      id: randomUUID(),
      scope: repo ? "repo" : "global",
      project: repo ? process.cwd() : null,
      kind: "fact",
      text,
      state: "active",
      created: new Date().toISOString(),
      source: null,
      supersedes,
      writtenBy: "human",
      supersededAt: null,
    };
    db.transaction(() => saveNote(db, note))();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(note)}\n`, { encoding: "utf8" });
    printJson({ saved: note.id, scope: note.scope, project: note.project, path });
  } finally {
    db.close();
  }
}

function runForget(args: ParsedArgs): void {
  const id = args.positionals.join(" ").trim();
  if (!id) {
    throw new Error("mem forget 需要笔记 id");
  }
  const db = openDatabase(dbPathFrom(args));
  try {
    const result = db
      .prepare(
        `UPDATE notes SET state = 'archived', superseded_at = ?
         WHERE id = ? AND state = 'active'`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new Error(`找不到 active 笔记: ${id}`);
    }
    printJson({ archived: id });
  } finally {
    db.close();
  }
}

function runNotes(args: ParsedArgs): void {
  const dbPath = dbPathFrom(args);
  // openDatabase runs the additive column migration; an index created before
  // notes could be corrected otherwise reports written_by as missing.
  const db = openDatabase(dbPath);
  try {
    const all = args.flags.has("--all");
    const rows = db
      .prepare(
        `SELECT id, scope, project, kind, text, state, created, source,
                supersedes,
                written_by AS writtenBy,
                superseded_at AS supersededAt
         FROM notes ${all ? "" : "WHERE state = 'active'"}
         ORDER BY created DESC, id`,
      )
      .all() as Note[];
    if (rows.length === 0) {
      return;
    }
    process.stdout.write(
      `${rows
        .map(
          (note) =>
            `${note.id}\t${note.state}\t${note.scope}\t${note.project ?? "-"}\t${note.created ?? "-"}\t${note.writtenBy ?? "-"}\t${note.supersedes ?? "-"}\t${note.text}`,
        )
        .join("\n")}\n`,
    );
  } finally {
    db.close();
  }
}

function runDoctor(args: ParsedArgs): void {
  const dbPath = dbPathFrom(args);
  if (!existsSync(dbPath)) {
    throw new Error(`索引不存在: ${dbPath}`);
  }
  const db = openReadDatabase(dbPath);
  try {
    const details = databaseSummary(db, dbPath);
    const walBytes = existsSync(`${dbPath}-wal`)
      ? statSync(`${dbPath}-wal`).size
      : 0;
    const lock = existsSync(`${dbPath}.index.lock`);
    printJson({
      status:
        (details.sessions as number) > 0 &&
        walBytes === 0 &&
        !lock
          ? "ok"
          : "attention",
      ...details,
      walBytes,
      indexLock: lock,
    });
  } finally {
    db.close();
  }
}

function runStats(args: ParsedArgs): void {
  const dbPath = dbPathFrom(args);
  const db = requireDatabase(dbPath);
  try {
    printJson(databaseSummary(db, dbPath));
  } finally {
    db.close();
  }
}

function runExport(args: ParsedArgs): void {
  const out = args.options.get("--out");
  if (!out) {
    throw new Error("mem export 需要 --out <目录>");
  }
  const stats = exportAll({
    dbPath: dbPathFrom(args),
    outDir: resolve(out.replace(/^~(?=$|\/)/, homedir())),
    force: args.flags.has("--force"),
  });
  printJson(stats);
}

function runRestore(args: ParsedArgs): void {
  const from = args.options.get("--from");
  if (!from) {
    throw new Error("mem restore 需要 --from <目录>");
  }
  const stats = restoreAll({
    fromDir: resolve(from.replace(/^~(?=$|\/)/, homedir())),
    dbPath: dbPathFrom(args),
  });
  printJson(stats);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.flags.has("--version") || args.flags.has("-v")) {
    const { readFileSync } = await import("node:fs");
    const pkg = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    process.stdout.write(`${pkg.version}\n`);
    return;
  }
  if (
    !args.command ||
    args.flags.has("--help") ||
    args.flags.has("-h") ||
    args.flags.has("help")
  ) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  switch (args.command) {
    case "index":
      await runIndex(args);
      return;
    case "recall":
      runRecall(args);
      return;
    case "search":
      runSearch(args);
      return;
    case "ctx":
      runCtx(args);
      return;
    case "show":
      runShow(args);
      return;
    case "remember":
      runRemember(args);
      return;
    case "forget":
      runForget(args);
      return;
    case "notes":
      runNotes(args);
      return;
    case "doctor":
      runDoctor(args);
      return;
    case "stats":
      runStats(args);
      return;
    case "export":
      runExport(args);
      return;
    case "restore":
      runRestore(args);
      return;
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`mem: ${(error as Error).message}\n`);
  process.exitCode = 2;
});
