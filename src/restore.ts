import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

import {
  insertNoteRow,
  openDatabase,
  putSessionExact,
  saveNote,
  setMeta,
  upsertFileState,
} from "./db.js";
import { EXPORT_FORMAT, EXPORT_VERSION, type Manifest } from "./export.js";
import { insertMessage, insertMessageWithId } from "./ingest.js";
import type { AgentName, MessageRole, Note } from "./types.js";

export interface RestoreOptions {
  fromDir: string;
  dbPath: string;
}

export interface RestoreStats {
  dbPath: string;
  sessions: number;
  messages: number;
  files: number;
  notes: number;
  bytes: number;
  elapsedMs: number;
}

interface SessionLine {
  type: "session";
  id: string;
  agent: AgentName;
  project: string | null;
  cwd: string | null;
  title: string | null;
  path: string | null;
  startedAt: string | null;
  updatedAt: string | null;
  settled: number;
  gaveUp: number;
  pasted: number;
  words: number;
  sidechain: number;
}

interface MessageLine {
  type: "msg";
  id?: number;
  ordinal: number;
  ts: string | null;
  role: MessageRole;
  kind: string;
  text: string;
  meta?: string | null;
}

function resolveInside(root: string, relativePath: string): string {
  const full = resolve(root, relativePath);
  if (full !== root && !full.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)) {
    throw new Error(`导出文件路径越界: ${relativePath}`);
  }
  return full;
}

function readLines(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function loadManifest(fromDir: string): Manifest {
  const manifestPath = join(fromDir, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`不是有效的导出目录（缺少 manifest.json）: ${fromDir}`);
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Manifest;
  } catch (error) {
    throw new Error(`manifest.json 解析失败: ${(error as Error).message}`);
  }
  if (manifest.format !== EXPORT_FORMAT) {
    throw new Error(`未知导出格式: ${String(manifest.format)}`);
  }
  if (manifest.version !== EXPORT_VERSION) {
    throw new Error(
      `导出格式版本不支持: ${String(manifest.version)}（当前支持 ${EXPORT_VERSION}）`,
    );
  }
  return manifest;
}

function noteFromJson(raw: unknown, source: string): Note {
  const value = raw as Partial<Note>;
  if (!value || typeof value.id !== "string" || typeof value.text !== "string") {
    throw new Error(`笔记格式错误: ${source}`);
  }
  return {
    id: value.id,
    scope: value.scope ?? "global",
    project: value.project ?? null,
    kind: value.kind ?? "fact",
    text: value.text,
    state: value.state ?? "active",
    created: value.created ?? null,
    source: value.source ?? null,
    supersedes: value.supersedes ?? null,
    writtenBy: value.writtenBy ?? "human",
    supersededAt: value.supersededAt ?? null,
  };
}

export function restoreAll(options: RestoreOptions): RestoreStats {
  const started = performance.now();
  const fromDir = resolve(options.fromDir);
  const dbPath = resolve(options.dbPath);
  const manifest = loadManifest(fromDir);
  const db = openDatabase(dbPath);
  let sessions = 0;
  let messages = 0;
  let notes = 0;
  try {
    const existing = db
      .prepare("SELECT count(*) AS n FROM sessions")
      .get() as { n: number };
    if (existing.n > 0) {
      throw new Error(`目标索引已有 ${existing.n} 个会话，拒绝覆盖: ${dbPath}`);
    }

    db.transaction(() => {
      for (const entry of manifest.sessions) {
        if (!entry.file.endsWith(".jsonl")) {
          throw new Error(`会话文件必须是 .jsonl: ${entry.file}`);
        }
        const full = resolveInside(fromDir, entry.file);
        if (!existsSync(full)) {
          throw new Error(`缺少会话文件: ${entry.file}`);
        }
        const lines = readLines(full);
        if (lines.length === 0) {
          throw new Error(`会话文件为空: ${entry.file}`);
        }
        const session = JSON.parse(lines[0]!) as SessionLine;
        if (session.type !== "session" || session.id !== entry.sid) {
          throw new Error(`会话文件首行与 manifest 不一致: ${entry.file}`);
        }
        if (lines.length - 1 !== entry.messages) {
          throw new Error(
            `会话消息数与 manifest 不一致: ${entry.file}（${lines.length - 1} != ${entry.messages}）`,
          );
        }
        putSessionExact(db, {
          id: session.id,
          agent: session.agent,
          project: session.project,
          cwd: session.cwd,
          title: session.title,
          path: session.path,
          startedAt: session.startedAt,
          updatedAt: session.updatedAt,
          settled: session.settled !== 0,
          gaveUp: session.gaveUp !== 0,
          pasted: session.pasted !== 0,
          words: session.words,
          sidechain: session.sidechain !== 0,
        });
        for (const line of lines.slice(1)) {
          const message = JSON.parse(line) as MessageLine;
          if (message.type !== "msg") {
            throw new Error(`会话文件含未知行类型: ${entry.file}`);
          }
          const parsed = {
            sid: session.id,
            ordinal: message.ordinal,
            timestamp: message.ts ?? null,
            role: message.role,
            kind: message.kind,
            text: message.text,
            cwd: null,
            meta: message.meta ?? null,
          };
          if (
            typeof message.id === "number" &&
            Number.isInteger(message.id) &&
            message.id > 0
          ) {
            insertMessageWithId(db, parsed, message.id);
          } else {
            insertMessage(db, parsed);
          }
        }
        const stored = db
          .prepare("SELECT count(*) AS n FROM msgs WHERE sid = ?")
          .get(session.id) as { n: number };
        if (stored.n !== entry.messages) {
          throw new Error(
            `会话落库消息数不符: ${entry.file}（${stored.n} != ${entry.messages}）`,
          );
        }
        sessions += 1;
        messages += entry.messages;
      }

      for (const file of manifest.files) {
        upsertFileState(db, {
          path: file.path,
          agent: file.agent,
          size: file.size,
          mtimeNs: BigInt(file.mtimeNs),
          offset: file.offset,
          lineNo: file.lineNo,
          prefixSample: Buffer.from(file.prefixSample, "base64"),
          sid: file.sid,
        });
      }

      for (const [key, value] of Object.entries(manifest.meta)) {
        if (typeof value === "string") {
          setMeta(db, key, value);
        }
      }

      const statePath = join(fromDir, "notes", "state.jsonl");
      const eventPath = join(fromDir, "notes", "notes.jsonl");
      if (existsSync(statePath) && statSync(statePath).size > 0) {
        for (const line of readLines(statePath)) {
          insertNoteRow(db, noteFromJson(JSON.parse(line), "notes/state.jsonl"));
          notes += 1;
        }
      } else if (existsSync(eventPath)) {
        const known = new Set(
          (db.prepare("SELECT id FROM notes").all() as Array<{ id: string }>).map(
            (row) => row.id,
          ),
        );
        for (const line of readLines(eventPath)) {
          const note = noteFromJson(JSON.parse(line), "notes/notes.jsonl");
          if (known.has(note.id)) {
            continue;
          }
          saveNote(db, note);
          known.add(note.id);
          notes += 1;
        }
      }
    })();

    db.pragma("wal_checkpoint(TRUNCATE)");
    return {
      dbPath,
      sessions,
      messages,
      files: manifest.files.length,
      notes,
      bytes: existsSync(dbPath) ? statSync(dbPath).size : 0,
      elapsedMs: Math.round(performance.now() - started),
    };
  } finally {
    db.close();
  }
}
