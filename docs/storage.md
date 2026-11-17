# 存储架构

```text
~/.cache/mem/mem.db              SQLite WAL 模式，核心索引
~/.local/share/mem/notes.jsonl   全局笔记（scope=global）
<repo>/.mem/notes.jsonl          仓库作用域笔记（scope=repo）
```

- `sessions` — 会话元数据（agent、project、title、时间、决策 / 粘贴 / 放弃标记）
- `msgs` — **全量**消息文本 + `role` 列（user / assistant / tool_call / tool_result / compaction），会话正文原样入；`notes` 写入前过 `redact`
- `msgs_fts` — FTS5 全文索引：应用层先分词（标识符拆分 + CJK 二元组），写入预分词的 `tokens` 列，FTS 自身用 unicode61 原样收词；原文只存 `msgs`，不进 FTS
- `files` — 文件水印（size + mtime_ns + offset + 前缀采样），增量解析依据
- `notes` / `notes_fts` — 显式记忆，带 `written_by`（固定 `human`）、`supersedes` 与 `superseded_at`
- `meta` — 索引时间、版本、文档频率

## 索引来源

| agent | 默认路径 | 覆盖变量 | 解析方式 |
|---|---|---|---|
| claude | `~/.claude/projects/**/*.jsonl` | `MEM_CLAUDE_ROOT` | 行追加；截断重写则整文件重建 |
| codex | `~/.codex/sessions/**/*.jsonl` | `MEM_CODEX_ROOT` | 同上 |
| opencode | `~/.local/share/opencode/opencode.db` | `MEM_OPENCODE_DB` | 每次整库重读 |
| qoder | `~/.qoder/projects/**/*.jsonl` | `MEM_QODER_ROOT` | 与 claude 同构，共用解析器 |
| pi | `~/.pi/agent/sessions/**/*.jsonl` | `MEM_PI_ROOT` | 行追加；session 头取 id 与 cwd |
| dsh | `~/.dsh/sessions/**/session.v4.jsonl.zstd` | `MEM_DSH_ROOT` | 逐帧 zstd 解码，变化即整会话重建 |
| antigravity | `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript_full.jsonl` | `MEM_ANTIGRAVITY_ROOT` | 变化即整会话重建；缺 full 时退回 `transcript.jsonl` |

dsh 需要 Node ≥ 22.15 的 `zlib.zstdDecompressSync`；版本不足时该来源记入 `stats.errors`，其余来源照常索引。所有来源的 thinking / reasoning 块都不入库。

笔记是唯一会持久化的记忆视图，因此也是唯一**会被写错、会被纠正**的一层。`remember --supersedes <id>` 把旧条目置为 `superseded` 并记下新条目的 `written_by` 与时间戳；`forget <id>` 归档；`notes --all` 保留完整历史而不是物理删除。原则是「Traces are append-only, memories get corrected」：一条一月写的规则三月被推翻，两份都得像样地留着，后来的读者才知道哪份过期了。旧索引在打开时自动补齐这三列，不需要重建。

前缀采样这一条不是多余的：只看 size 变大不够，「截断后重新增长」会伪装成 append，必须比对旧前缀才能保证增量正确。
