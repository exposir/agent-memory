import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";

import Database from "better-sqlite3";

import { databasePath, deleteSessionData, getFileState, openDatabase, setMeta, upsertFileState, upsertSession } from "./db.js";
import { insertMessage, type ParsedMessage } from "./ingest.js";
import { readAntigravityTranscript } from "./parsers/antigravity.js";
import { parseClaudeLine } from "./parsers/claude.js";
import { parseCodexLine } from "./parsers/codex.js";
import { readDshSession } from "./parsers/dsh.js";
import { readOpencodeSessions } from "./parsers/opencode.js";
import { parsePiLine } from "./parsers/pi.js";
import { parseQoderLine } from "./parsers/qoder.js";
import { GAVE_UP_PHRASES, carriesDecision } from "./recall.js";
import { tokenize } from "./tokenize.js";
import type { AgentName, MessageRole } from "./types.js";

const MAX_LINE_BYTES = 2_000_000;
const PREFIX_BYTES = 4_096;

export interface IndexRoots {
  claude: string;
  codex: string;
  opencode: string;
  qoder: string;
  pi: string;
  dsh: string;
  antigravity: string;
}

export interface IndexOptions {
  dbPath?: string;
  roots?: Partial<IndexRoots>;
  quiet?: boolean;
  now?: Date;
}

export interface IndexStats {
  dbPath: string;
  elapsedMs: number;
  filesScanned: number;
  filesIndexed: number;
  filesSkipped: number;
  filesRebuilt: number;
  messages: number;
  sessions: number;
  errors: string[];
  dbBytes: number;
  walBytes: number;
}

interface SessionState {
  id: string;
  agent: AgentName;
  project: string;
  cwd: string | null;
  title: string | null;
  path: string;
  startedAt: string | null;
  updatedAt: string | null;
  words: number;
  settled: boolean;
  gaveUp: boolean;
  pasted: boolean;
}

function defaultRoots(): IndexRoots {
  return {
    claude: join(homedir(), ".claude", "projects"),
    codex: join(homedir(), ".codex", "sessions"),
    opencode: join(homedir(), ".local", "share", "opencode", "opencode.db"),
    qoder: join(homedir(), ".qoder", "projects"),
    pi: join(homedir(), ".pi", "agent", "sessions"),
    dsh: join(homedir(), ".dsh", "sessions"),
    antigravity: join(homedir(), ".gemini", "antigravity-cli", "brain"),
  };
}

function walkJsonl(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop()!;
    const children = statSync(directory);
    if (!children.isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

function walkNamedFiles(root: string, name: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const files: string[] = [];
  const queue = [root];
  while (queue.length > 0) {
    const directory = queue.pop()!;
    let children;
    try {
      children = statSync(directory);
    } catch {
      continue;
    }
    if (!children.isDirectory()) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        queue.push(path);
      } else if (entry.isFile() && entry.name === name) {
        files.push(path);
      }
    }
  }
  return files.sort();
}

function dshSessionId(path: string): string {
  const directory = basename(dirname(path));
  return directory.startsWith("session-") ? directory.slice("session-".length) : directory;
}

function piFileSid(path: string): string {
  const base = basename(path, ".jsonl");
  const match = base.match(
    /_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
  );
  return match?.[1] ?? base;
}

function walkAntigravityTranscripts(root: string): Array<{ path: string; sid: string }> {
  if (!existsSync(root)) {
    return [];
  }
  const files: Array<{ path: string; sid: string }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const logs = join(root, entry.name, ".system_generated", "logs");
    const full = join(logs, "transcript_full.jsonl");
    const plain = join(logs, "transcript.jsonl");
    if (existsSync(full)) {
      files.push({ path: full, sid: entry.name });
    } else if (existsSync(plain)) {
      files.push({ path: plain, sid: entry.name });
    }
  }
  return files.sort((left, right) => left.sid.localeCompare(right.sid));
}

function readPrefix(path: string, bytes = PREFIX_BYTES): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const count = readSync(fd, buffer, 0, bytes, 0);
    return new Uint8Array(buffer.subarray(0, count));
  } finally {
    closeSync(fd);
  }
}

function samePrefix(left: Uint8Array, right: Uint8Array): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && leftBuffer.equals(rightBuffer);
}

function safeSize(path: string, size: number): number {
  if (size <= 0) {
    return 0;
  }
  const fd = openSync(path, "r");
  try {
    const tail = Buffer.alloc(1);
    readSync(fd, tail, 0, 1, size - 1);
    if (tail[0] === 0x0a) {
      return size;
    }
    const chunkSize = 8_192;
    for (let end = size; end > 0; end -= chunkSize) {
      const start = Math.max(0, end - chunkSize);
      const buffer = Buffer.alloc(end - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const newline = buffer.lastIndexOf(0x0a);
      if (newline >= 0) {
        return start + newline + 1;
      }
    }
    return 0;
  } finally {
    closeSync(fd);
  }
}

function firstLine(text: string, maxChars = 160): string | null {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed) {
      return [...trimmed].slice(0, maxChars).join("");
    }
  }
  return null;
}

function earliest(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left <= right ? left : right;
}

function latest(left: string | null, right: string | null): string | null {
  if (!left) return right;
  if (!right) return left;
  return left >= right ? left : right;
}

function sessionFromDatabase(db: Database.Database, sid: string): SessionState | null {
  const row = db
    .prepare(
      `SELECT id, agent, project, cwd, title, path, started_at, updated_at,
              settled, gave_up, pasted
       FROM sessions WHERE id = ?`,
    )
    .get(sid) as
    | {
        id: string;
        agent: AgentName;
        project: string | null;
        cwd: string | null;
        title: string | null;
        path: string;
        started_at: string | null;
        updated_at: string | null;
        settled: number;
        gave_up: number;
        pasted: number;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        agent: row.agent,
        project: row.project ?? "",
        cwd: row.cwd,
        title: row.title,
        path: row.path,
        startedAt: row.started_at,
        updatedAt: row.updated_at,
        words: 0,
        settled: row.settled !== 0,
        gaveUp: row.gave_up !== 0,
        pasted: row.pasted !== 0,
      }
    : null;
}

function newSessionState(input: {
  sid: string;
  agent: AgentName;
  project: string;
  cwd: string | null;
  path: string;
  timestamp?: string | null;
}): SessionState {
  return {
    id: input.sid,
    agent: input.agent,
    project: input.project,
    cwd: input.cwd,
    title: null,
    path: input.path,
    startedAt: input.timestamp ?? null,
    updatedAt: input.timestamp ?? null,
    words: 0,
    settled: false,
    gaveUp: false,
    pasted: false,
  };
}

function updateSessionState(session: SessionState, message: ParsedMessage): void {
  session.startedAt = earliest(session.startedAt, message.timestamp);
  session.updatedAt = latest(session.updatedAt, message.timestamp);
  session.words += tokenize(message.text).length;
  if (message.cwd && !session.cwd) {
    session.cwd = message.cwd;
  }
  if (!session.title && message.role === "user") {
    session.title = firstLine(message.text);
  }
  if (message.role === "assistant" && carriesDecision(message.text)) {
    session.settled = true;
  }
  const low = message.text.toLowerCase();
  if (message.role !== "tool_call" && message.role !== "tool_result") {
    session.gaveUp ||= GAVE_UP_PHRASES.some((phrase) => low.includes(phrase));
  }
  const lines = message.text.split(/\r?\n/).map((line) => line.trim());
  if (lines.length >= 8) {
    const distinct = new Set(lines).size / lines.length;
    session.pasted ||= distinct < 0.35;
  }
}

async function readRange(
  path: string,
  start: number,
  end: number,
  startOrdinal: number,
  onLine: (line: string, ordinal: number) => void,
): Promise<number> {
  if (end <= start) {
    return startOrdinal;
  }
  let ordinal = startOrdinal;
  const stream = createReadStream(path, { start, end: end - 1, encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    onLine(line, ordinal);
    ordinal += 1;
  }
  return ordinal;
}

function claudeProject(path: string, root: string): string {
  const rel = relative(root, path);
  return rel.split(/[\\/]/)[0] || basename(dirname(path));
}

function codexFileSid(path: string): string {
  return (
    basename(path, ".jsonl").match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )?.[0] ?? basename(path, ".jsonl")
  );
}

interface ProcessedFile {
  messages: number;
  session: SessionState | null;
  mode: "skip" | "append" | "rebuild";
}

async function processJsonlFile(
  db: Database.Database,
  path: string,
  agent: "claude" | "codex" | "qoder" | "pi",
  transcriptsRoot: string,
): Promise<ProcessedFile> {
  const stats = statSync(path, { bigint: true });
  const size = Number(stats.size);
  const mtimeNs = stats.mtimeNs;
  const prefix = readPrefix(path);
  const boundary = safeSize(path, size);
  const existingState = getFileState(db, path);
  const fallbackSid =
    existingState?.sid ??
    (agent === "codex"
      ? codexFileSid(path)
      : agent === "pi"
        ? piFileSid(path)
        : basename(path, ".jsonl"));
  const project =
    agent === "claude" || agent === "qoder"
      ? claudeProject(path, transcriptsRoot)
      : "unknown";

  let mode: "append" | "rebuild" = "rebuild";
  if (existingState) {
    if (size === existingState.size && mtimeNs === existingState.mtimeNs) {
      return { messages: 0, session: null, mode: "skip" };
    }
    if (
      size >= existingState.size &&
      boundary >= existingState.offset &&
      samePrefix(prefix, existingState.prefixSample)
    ) {
      mode = "append";
    }
  }
  const startOffset = mode === "append" ? existingState!.offset : 0;
  const startOrdinal = mode === "append" ? existingState!.lineNo : 0;
  let session =
    (mode === "append" ? sessionFromDatabase(db, fallbackSid) : null) ??
    newSessionState({
      sid: fallbackSid,
      agent,
      project,
      cwd: agent === "claude" || agent === "qoder" ? project : null,
      path,
    });
  let sid = session.id;
  let messages = 0;
  const cleared = new Set<string>();
  const clearOnce = (value: string): void => {
    if (mode !== "rebuild" || cleared.has(value)) {
      return;
    }
    deleteSessionData(db, value);
    cleared.add(value);
  };

  db.exec("BEGIN IMMEDIATE");
  try {
    if (mode === "rebuild") {
      if (existingState?.sid) {
        clearOnce(existingState.sid);
      }
      clearOnce(sid);
    }

    const nextOrdinal = await readRange(path, startOffset, boundary, startOrdinal, (line, ordinal) => {
      if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
        return;
      }
      if (agent === "claude" || agent === "qoder") {
        const parsed =
          agent === "claude"
            ? parseClaudeLine(line, sid, ordinal, project)
            : parseQoderLine(line, sid, ordinal, project);
        if (parsed) {
          clearOnce(sid);
          const message: ParsedMessage = {
            sid,
            ordinal: parsed.ordinal,
            timestamp: parsed.timestamp,
            role: parsed.role,
            kind: parsed.kind,
            text: parsed.text,
            cwd: parsed.cwd,
          };
          insertMessage(db, message);
          updateSessionState(session, message);
          messages += 1;
        }
        return;
      }

      const parsed =
        agent === "pi"
          ? parsePiLine(line, sid, ordinal)
          : parseCodexLine(line, sid, ordinal);
      if (!parsed) {
        return;
      }
      if (parsed.type === "session") {
        if (mode !== "append" && parsed.value.sid !== sid) {
          sid = parsed.value.sid;
          clearOnce(sid);
          session = newSessionState({
            sid,
            agent,
            project: parsed.value.cwd ?? project,
            cwd: parsed.value.cwd,
            path,
            timestamp: parsed.value.timestamp,
          });
        } else if (!session.cwd && parsed.value.cwd) {
          session.cwd = parsed.value.cwd;
          session.project = parsed.value.cwd;
        }
        session.startedAt = earliest(session.startedAt, parsed.value.timestamp);
        return;
      }
      const message: ParsedMessage = parsed.value;
      message.sid = sid;
      insertMessage(db, message);
      updateSessionState(session, message);
      messages += 1;
    });

    if (messages > 0 || session.title) {
      upsertSession(db, {
        id: session.id,
        agent: session.agent,
        project: session.project,
        cwd: session.cwd,
        title: session.title,
        path: session.path,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        settled: session.settled,
        gaveUp: session.gaveUp,
        pasted: session.pasted,
        words: session.words,
        sidechain: false,
      });
    }
    upsertFileState(db, {
      path,
      agent,
      size,
      mtimeNs,
      offset: boundary,
      lineNo: nextOrdinal,
      prefixSample: prefix,
      sid: session.id,
    });
    db.exec("COMMIT");
    return { messages, session, mode };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

interface WholeParsedSession {
  sid: string;
  cwd: string | null;
  startedAt: string | null;
  messages: Array<{
    ordinal: number;
    timestamp: string | null;
    role: MessageRole;
    kind: string;
    text: string;
  }>;
}

function processWholeFile(
  db: Database.Database,
  path: string,
  agent: "dsh" | "antigravity",
  sid: string,
): ProcessedFile {
  const stats = statSync(path, { bigint: true });
  const size = Number(stats.size);
  const mtimeNs = stats.mtimeNs;
  const existingState = getFileState(db, path);
  if (existingState && size === existingState.size && mtimeNs === existingState.mtimeNs) {
    return { messages: 0, session: null, mode: "skip" };
  }

  const parsed: WholeParsedSession =
    agent === "dsh" ? readDshSession(path, sid) : readAntigravityTranscript(path, sid);

  db.exec("BEGIN IMMEDIATE");
  try {
    if (existingState?.sid) {
      deleteSessionData(db, existingState.sid);
    }
    deleteSessionData(db, parsed.sid);
    const session = newSessionState({
      sid: parsed.sid,
      agent,
      project: parsed.cwd ?? "",
      cwd: parsed.cwd,
      path,
      timestamp: parsed.startedAt,
    });
    let messages = 0;
    for (const entry of parsed.messages) {
      const message: ParsedMessage = {
        sid: parsed.sid,
        ordinal: entry.ordinal,
        timestamp: entry.timestamp,
        role: entry.role,
        kind: entry.kind,
        text: entry.text,
        cwd: parsed.cwd,
      };
      insertMessage(db, message);
      updateSessionState(session, message);
      messages += 1;
    }
    if (messages > 0 || session.title) {
      upsertSession(db, {
        id: session.id,
        agent: session.agent,
        project: session.project,
        cwd: session.cwd,
        title: session.title,
        path: session.path,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
        settled: session.settled,
        gaveUp: session.gaveUp,
        pasted: session.pasted,
        words: session.words,
        sidechain: false,
      });
    }
    upsertFileState(db, {
      path,
      agent,
      size,
      mtimeNs,
      offset: 0,
      lineNo: messages,
      prefixSample: new Uint8Array(),
      sid: parsed.sid,
    });
    db.exec("COMMIT");
    return { messages, session, mode: "rebuild" };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ingestOpencode(
  db: Database.Database,
  path: string,
): { messages: number; sessions: number } {
  if (!existsSync(path)) {
    return { messages: 0, sessions: 0 };
  }
  const sessions = readOpencodeSessions(path);
  const stats = statSync(path, { bigint: true });
  const prefix = readPrefix(path);
  const existing = readFileStateIds(db, "opencode");
  let messages = 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    for (const sid of existing) {
      deleteSessionData(db, sid);
    }
    for (const session of sessions) {
      let state = newSessionState({
        sid: session.sid,
        agent: "opencode",
        project: session.project,
        cwd: session.project,
        path,
        timestamp: session.startedAt,
      });
      state.title = session.title;
      state.updatedAt = session.updatedAt;
      for (const message of session.messages) {
        insertMessage(db, {
          sid: session.sid,
          ordinal: message.ordinal,
          timestamp: message.timestamp,
          role: message.role,
          kind: message.kind,
          text: message.text,
          cwd: session.project,
        });
        updateSessionState(state, {
          sid: session.sid,
          ordinal: message.ordinal,
          timestamp: message.timestamp,
          role: message.role,
          kind: message.kind,
          text: message.text,
          cwd: session.project,
        });
        messages += 1;
      }
      upsertSession(db, {
        id: state.id,
        agent: "opencode",
        project: state.project,
        cwd: state.cwd,
        title: state.title,
        path,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
        settled: state.settled,
        gaveUp: state.gaveUp,
        pasted: state.pasted,
        words: state.words,
        sidechain: false,
      });
    }
    upsertFileState(db, {
      path,
      agent: "opencode",
      size: Number(stats.size),
      mtimeNs: stats.mtimeNs,
      offset: 0,
      lineNo: 0,
      prefixSample: prefix,
      sid: null,
    });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { messages, sessions: sessions.length };
}

function readFileStateIds(db: Database.Database, agent: string): string[] {
  return (
    db.prepare("SELECT id FROM sessions WHERE agent = ?").all(agent) as Array<{ id: string }>
  ).map((row) => row.id);
}

function acquireLock(database: string): () => void {
  const lockPath = `${database}.index.lock`;
  mkdirSync(dirname(lockPath), { recursive: true });
  const open = (): number | null => {
    try {
      return openSync(lockPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
      return null;
    }
  };
  let fd = open();
  if (fd === null) {
    const pid = Number(readFileSync(lockPath, "utf8").trim().split(/\s+/)[0]);
    let alive = false;
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        alive = true;
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new Error(`another indexer is running (pid ${pid})`);
    }
    rmSync(lockPath, { force: true });
    fd = open();
  }
  if (fd === null) {
    throw new Error("could not acquire index lock");
  }
  writeFileSync(fd, `${process.pid}\n${new Date().toISOString()}\n`);
  return () => {
    closeSync(fd!);
    rmSync(lockPath, { force: true });
  };
}

function fileSize(path: string): number {
  return existsSync(path) ? Number(statSync(path).size) : 0;
}

export async function indexAll(options: IndexOptions = {}): Promise<IndexStats> {
  const started = performance.now();
  const dbPath = options.dbPath ?? databasePath();
  const roots = { ...defaultRoots(), ...options.roots };
  const release = acquireLock(dbPath);
  const stats: IndexStats = {
    dbPath,
    elapsedMs: 0,
    filesScanned: 0,
    filesIndexed: 0,
    filesSkipped: 0,
    filesRebuilt: 0,
    messages: 0,
    sessions: 0,
    errors: [],
    dbBytes: 0,
    walBytes: 0,
  };

  try {
    const db = openDatabase(dbPath);
    try {
      const jsonlFiles = [
        ...walkJsonl(roots.claude).map((path) => ({
          kind: "jsonl" as const,
          path,
          agent: "claude" as const,
          root: roots.claude,
        })),
        ...walkJsonl(roots.codex).map((path) => ({
          kind: "jsonl" as const,
          path,
          agent: "codex" as const,
          root: roots.codex,
        })),
        ...walkJsonl(roots.qoder).map((path) => ({
          kind: "jsonl" as const,
          path,
          agent: "qoder" as const,
          root: roots.qoder,
        })),
        ...walkJsonl(roots.pi).map((path) => ({
          kind: "jsonl" as const,
          path,
          agent: "pi" as const,
          root: roots.pi,
        })),
      ];
      const wholeFiles = [
        ...walkNamedFiles(roots.dsh, "session.v4.jsonl.zstd").map((path) => ({
          kind: "whole" as const,
          path,
          agent: "dsh" as const,
          sid: dshSessionId(path),
        })),
        ...walkAntigravityTranscripts(roots.antigravity).map(({ path, sid }) => ({
          kind: "whole" as const,
          path,
          agent: "antigravity" as const,
          sid,
        })),
      ];
      const allFiles = [...jsonlFiles, ...wholeFiles];
      stats.filesScanned = allFiles.length + (existsSync(roots.opencode) ? 1 : 0);
      let processed = 0;

      for (const file of allFiles) {
        try {
          const result =
            file.kind === "jsonl"
              ? await processJsonlFile(db, file.path, file.agent, file.root)
              : processWholeFile(db, file.path, file.agent, file.sid);
          if (result.mode === "skip") {
            stats.filesSkipped += 1;
          } else {
            stats.filesIndexed += 1;
            stats.messages += result.messages;
            if (result.mode === "rebuild") {
              stats.filesRebuilt += 1;
            }
          }
        } catch (error) {
          stats.errors.push(`${file.agent}:${file.path}: ${(error as Error).message}`);
        }
        processed += 1;
        if (!options.quiet && processed % 100 === 0) {
          process.stderr.write(`indexed files ${processed}/${allFiles.length}\n`);
        }
      }

      try {
        const opencode = ingestOpencode(db, roots.opencode);
        stats.messages += opencode.messages;
        stats.filesIndexed += opencode.sessions > 0 ? 1 : 0;
      } catch (error) {
        stats.errors.push(`opencode:${roots.opencode}: ${(error as Error).message}`);
      }
      const counts = db
        .prepare(
          `SELECT
             (SELECT count(*) FROM sessions) AS sessions,
             (SELECT count(*) FROM msgs) AS messages`,
        )
        .get() as { sessions: number; messages: number };
      stats.sessions = counts.sessions;
      stats.messages = counts.messages;
      setMeta(db, "indexed_at", (options.now ?? new Date()).toISOString());
      setMeta(db, "index_sessions", String(counts.sessions));
      setMeta(db, "index_messages", String(counts.messages));
      db.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      db.close();
    }
  } finally {
    release();
  }

  stats.elapsedMs = Math.round(performance.now() - started);
  stats.dbBytes = fileSize(dbPath);
  stats.walBytes = fileSize(`${dbPath}-wal`);
  return stats;
}
