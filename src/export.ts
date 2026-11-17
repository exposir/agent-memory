import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { openReadDatabase } from "./db.js";
import type { AgentName, MessageRole, Note } from "./types.js";

export const EXPORT_FORMAT = "agent-memory-export";
export const EXPORT_VERSION = 1;

export interface ExportOptions {
  dbPath: string;
  outDir: string;
  force?: boolean;
}

export interface ExportStats {
  outDir: string;
  sessions: number;
  messages: number;
  files: number;
  notes: number;
  bytes: number;
  elapsedMs: number;
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
  sidechain: number;
}

interface MessageRow {
  id: number;
  ordinal: number;
  ts: string | null;
  role: MessageRole;
  kind: string;
  text: string;
  meta: string | null;
}

interface FileRow {
  path: string;
  agent: AgentName;
  size: number;
  mtime_ns: string;
  offset: number;
  line_no: number;
  prefix_sample: Buffer;
  sid: string | null;
}

interface NoteRow {
  id: string;
  scope: Note["scope"];
  project: string | null;
  kind: string;
  text: string;
  state: Note["state"];
  created: string | null;
  source: string | null;
  supersedes: string | null;
  written_by: string | null;
  superseded_at: string | null;
}

export interface ManifestSession {
  file: string;
  sid: string;
  messages: number;
}

export interface ManifestFile {
  path: string;
  agent: AgentName;
  size: number;
  mtimeNs: string;
  offset: number;
  lineNo: number;
  prefixSample: string;
  sid: string | null;
}

export interface Manifest {
  format: string;
  version: number;
  exportedAt: string;
  counts: { sessions: number; messages: number; files: number; notes: number };
  sessions: ManifestSession[];
  files: ManifestFile[];
  meta: Record<string, string | null>;
}

function fileForSid(sid: string): string {
  const safe =
    sid.length <= 200 &&
    sid !== "." &&
    sid !== ".." &&
    /^[A-Za-z0-9._-]+$/.test(sid);
  return safe
    ? `${sid}.jsonl`
    : `${createHash("sha256").update(sid).digest("hex").slice(0, 16)}.jsonl`;
}

function sessionLine(row: SessionRow): string {
  return JSON.stringify({
    type: "session",
    id: row.id,
    agent: row.agent,
    project: row.project,
    cwd: row.cwd,
    title: row.title,
    path: row.path,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    settled: row.settled,
    gaveUp: row.gave_up,
    pasted: row.pasted,
    words: row.words,
    sidechain: row.sidechain,
  });
}

function messageLine(row: MessageRow): string {
  const line: Record<string, unknown> = {
    type: "msg",
    id: row.id,
    ordinal: row.ordinal,
    ts: row.ts,
    role: row.role,
    kind: row.kind,
    text: row.text,
  };
  if (row.meta !== null) {
    line.meta = row.meta;
  }
  return JSON.stringify(line);
}

function noteLine(row: NoteRow): string {
  return JSON.stringify({
    id: row.id,
    scope: row.scope,
    project: row.project,
    kind: row.kind,
    text: row.text,
    state: row.state,
    created: row.created,
    source: row.source,
    supersedes: row.supersedes,
    writtenBy: row.written_by,
    supersededAt: row.superseded_at,
  } satisfies Note);
}

function notesLogPath(): string {
  const override = process.env.MEM_GLOBAL_NOTES;
  if (override) {
    return resolve(override.replace(/^~(?=$|\/)/, homedir()));
  }
  return resolve(homedir(), ".local", "share", "mem", "notes.jsonl");
}

export function exportAll(options: ExportOptions): ExportStats {
  const started = performance.now();
  const dbPath = resolve(options.dbPath);
  const outDir = resolve(options.outDir);
  if (!existsSync(dbPath)) {
    throw new Error(`索引不存在: ${dbPath}\n先运行 mem index`);
  }
  if (existsSync(outDir) && readdirSync(outDir).length > 0 && !options.force) {
    throw new Error(
      `导出目录非空: ${outDir}\n加 --force 覆盖 sessions/ 与 manifest.json`,
    );
  }
  mkdirSync(outDir, { recursive: true });
  const sessionsDir = join(outDir, "sessions");
  rmSync(sessionsDir, { recursive: true, force: true });
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(join(outDir, "notes"), { recursive: true });

  const db = openReadDatabase(dbPath);
  let bytes = 0;
  const manifestSessions: ManifestSession[] = [];
  try {
    db.exec("BEGIN");
    const sessions = db
      .prepare(
        `SELECT id, agent, project, cwd, title, path, started_at, updated_at,
                settled, gave_up, pasted, words, sidechain
         FROM sessions ORDER BY id`,
      )
      .all() as SessionRow[];
    const messagesFor = db.prepare(
      `SELECT id, ordinal, ts, role, kind, text, meta
       FROM msgs WHERE sid = ? ORDER BY ordinal`,
    );
    let messageTotal = 0;
    for (const session of sessions) {
      const messages = messagesFor.all(session.id) as MessageRow[];
      const body = `${[sessionLine(session), ...messages.map(messageLine)].join("\n")}\n`;
      const file = fileForSid(session.id);
      writeFileSync(join(sessionsDir, file), body);
      bytes += Buffer.byteLength(body);
      manifestSessions.push({
        file: `sessions/${file}`,
        sid: session.id,
        messages: messages.length,
      });
      messageTotal += messages.length;
    }

    const files = db
      .prepare(
        `SELECT path, agent, size, CAST(mtime_ns AS TEXT) AS mtime_ns,
                offset, line_no, prefix_sample, sid
         FROM files ORDER BY path`,
      )
      .all() as FileRow[];
    const metaRows = db
      .prepare("SELECT key, value FROM meta ORDER BY key")
      .all() as Array<{ key: string; value: string | null }>;
    const notes = db
      .prepare(
        `SELECT id, scope, project, kind, text, state, created, source,
                supersedes, written_by, superseded_at
         FROM notes ORDER BY id`,
      )
      .all() as NoteRow[];

    const statePath = join(outDir, "notes", "state.jsonl");
    if (notes.length > 0) {
      const body = `${notes.map(noteLine).join("\n")}\n`;
      writeFileSync(statePath, body);
      bytes += Buffer.byteLength(body);
    } else {
      rmSync(statePath, { force: true });
    }

    const eventPath = join(outDir, "notes", "notes.jsonl");
    const logPath = notesLogPath();
    if (existsSync(logPath)) {
      const body = readFileSync(logPath);
      writeFileSync(eventPath, body);
      bytes += body.length;
    } else {
      rmSync(eventPath, { force: true });
    }

    const manifest: Manifest = {
      format: EXPORT_FORMAT,
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      counts: {
        sessions: sessions.length,
        messages: messageTotal,
        files: files.length,
        notes: notes.length,
      },
      sessions: manifestSessions,
      files: files.map((row) => ({
        path: row.path,
        agent: row.agent,
        size: row.size,
        mtimeNs: row.mtime_ns,
        offset: row.offset,
        lineNo: row.line_no,
        prefixSample: row.prefix_sample.toString("base64"),
        sid: row.sid,
      })),
      meta: Object.fromEntries(metaRows.map((row) => [row.key, row.value])),
    };
    const manifestBody = `${JSON.stringify(manifest, null, 2)}\n`;
    writeFileSync(join(outDir, "manifest.json"), manifestBody);
    bytes += Buffer.byteLength(manifestBody);
    db.exec("COMMIT");

    return {
      outDir,
      sessions: sessions.length,
      messages: messageTotal,
      files: files.length,
      notes: notes.length,
      bytes,
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    db.close();
  }
}
