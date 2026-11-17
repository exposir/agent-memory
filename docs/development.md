# 开发

安装步骤见 [README 快速开始](../README.md#快速开始)。依赖 Node ≥ 20 与 better-sqlite3 自带的 SQLite；无 Python、无外部分词库、无模型服务。dsh 来源需要 Node ≥ 22.15（内置 zstd）。

```bash
npm run typecheck      # tsc --noEmit
npm test               # 77 个单测
npm run bench:build    # 合成语料 + 题库
npm run bench:queries  # 315 个 query case
npm run bench:validate # 题库校验（holder 唯一、负例 cross-pair、checksum）
npm run bench:search   # 官方 50 题门禁
npm run bench:methods  # 315 题全量 + 负例 recall 块判定
```

## 当前状态

七个来源（Claude Code / Codex / opencode / Qoder / pi / dsh / Antigravity）全部接入。合成语料评测：auto `rank=1 30/30` / `Recall@3 30/30`，known `rank=1 20/20` / `Recall@3 20/20`；315 题 positive `180/180`、known `120/120`、六类问法全部 `50/50`、负例 `0/15` 非空。口径与边界见 [验收](benchmark.md)，方法取舍见 [方法调研](methods.md)。

## 合成语料的结构

`bench/build-synthetic.ts` 确定性生成 65 个会话：21 个种子会话（每个携带一组题库答案词，holder 全库唯一）、4 个负例锚点会话（每个目标项目一个，携带负例查询的词但只有被阻断的工具输出，没有可注入的结论）、40 个填充会话（共享常见工程词汇让 IDF 分布真实，不携带任何种子的标识符词）。三种 agent 格式各写一份：Claude JSONL、Codex rollout JSONL、opencode SQLite。修改种子或锚点后必须重跑 `bench:build` → `bench:queries` → `bench:validate`，题库 JSON 的 checksum 记录在 `manifest.json`。