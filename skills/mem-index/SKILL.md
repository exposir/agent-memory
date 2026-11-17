---
name: mem-index
description: 手动把本机 Claude Code、Codex、opencode、Qoder、pi、dsh、Antigravity 会话增量写入 agent-memory，并把用户明确要求长期保留的事实写成显式笔记。仅在用户显式调用 /mem-index 时使用；不要因“存一下”“记住这个”“更新记忆索引”等口头请求自动触发。
---

# mem-index

这是写路径，只做两件事：增量索引会话，以及记录用户明确要求保存的笔记。

只有用户显式输入 `/mem-index` 时才执行。用户只口头说“存一下”“记住这个”“更新记忆索引”时不要自动调用；如果确实需要写入，先确认用户是否要运行 `/mem-index`。

## 索引

1. 手动触发运行 `mem index`，读取它输出的 JSON stats；外部调度才用 `mem index --quiet`。
2. 若退出码非 0，报告 stderr 的锁冲突或解析错误，不要删除索引库。
3. 汇报 `filesScanned`（扫描文件数）、`filesIndexed`（本次处理文件数）、`filesSkipped`（未变化文件数）、`filesRebuilt`（重建文件数）、`messages`（索引后库内消息总量）、`elapsedMs`、`errors`。`messages` 不是本次新增消息数。
4. 不要安装 hook，不要创建 cron，不要启动常驻进程。

## 显式笔记

只有用户明确要求长期记住的内容才写入笔记。

```bash
mem remember "要长期保留的事实"
mem remember --repo "只在当前仓库成立的约定"
```

- 写入前先压缩成一条可独立读懂的事实，不粘贴整段对话。
- 不保存密钥、令牌、密码、Cookie 或私钥；工具会再做一次脱敏。
- 临时进度、一次性的命令输出、助手推测都不要写成笔记。
- 只写「换个地方读不到」的内容：当前文件内容、`git status`、屏幕上的数字随时能重读，不值得记；为什么这么定、踩过的坑、验证过的规则才值得。

## 纠正与归档

人也会写错笔记，所以笔记不是 append-only：

```bash
mem notes                              # 列出 active，取 id
mem remember --supersedes <旧id> "更正后的事实"
mem forget <id>                        # 不再适用时归档
mem notes --all                        # 查看含 superseded / archived 的完整历史
```

- 覆盖旧笔记用 `--supersedes`，不要直接删库或改 SQLite；旧条目会置为 `superseded` 并保留历史。
- 已 `superseded` 或 `archived` 的条目不能再次覆盖。
- 纠错只发生在用户明确说「之前那条不对 / 改一下」时；不要自行推断笔记过期。

## 汇报

索引完成后按上面的 stats 字段报告；笔记完成后报告生成的 note id 与 JSONL 路径。
