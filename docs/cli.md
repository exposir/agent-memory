# CLI 参考

```text
mem index                       建/增量更新索引
mem index --quiet               静默增量，供外部调度调用
mem recall <查询> [--aggressive]  召回注入块（safe / aggressive）
mem search <查询> [--json]        按相关性打印命中
mem ctx                          当前上下文摘要
mem show <sid>                   查看某会话的原始消息（证据回源）
mem remember <内容>              写一条笔记（全局作用域）
mem remember --repo <内容>       写一条笔记（当前仓库作用域）
mem remember --supersedes <id> <内容>  纠正旧笔记，旧条目置 superseded
mem forget <id>                  归档一条笔记
mem notes                        列出 active 笔记
mem notes --all                  列出全部笔记（含 superseded / archived）
mem doctor                       索引状态、记录数、文件追踪、最后一次索引时间
mem stats                        索引统计
mem export --out <dir>           导出每会话一个 JSONL 快照（--force 覆盖已有 sessions/）
mem restore --from <dir>         从 JSONL 快照还原索引（目标库必须为空）
```

跨项目检索用 `--project <name>`（或 `MEM_PROJECT=<name>`）限定作用域。跨项目负例只有在带项目上下文时才可判定；同一句真实问题换个项目可能确实有答案。

当前会话自动排除，优先级为 `--current-sid` > `MEM_CURRENT_SID` > `CLAUDE_CODE_SESSION_ID` > `CODEX_SESSION_ID` > `OPENCODE_SESSION_ID`。

所有输出默认 UTF-8 中文。

## 快照导出与还原

```bash
mem export --out <dir>                 # 首次导出；目录非空时加 --force
mem restore --from <dir> --db <path>   # 目标库必须不存在或没有会话
```

导出目录结构：

```text
manifest.json          # 格式版本、计数、会话清单、files 表、meta
sessions/<sid>.jsonl   # 首行会话元数据，其后一行一条消息
notes/notes.jsonl      # 全局笔记事件日志（原样复制）
notes/state.jsonl      # 笔记当前状态（库中有笔记时才生成）
```

快照是纯文本，可 `grep` / `git diff`；`restore` 按当前代码的 schema 与 tokenizer 重建 FTS 与 `session_terms`，不读取原始 transcript。`version` 不匹配时拒绝还原。
