<div align="center">

# agent-memory

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**跨 agent 会话记忆检索器**

把 Claude Code、Codex、opencode、Qoder、pi、dsh、Antigravity 的历史消息索引成一份可检索的证据库；
查询时只抽出问题行与结论行，拼成一小块注入上下文。

**全量存储 · 查询时抽取（不物化视图）· 零 LLM 调用**

<sub>TypeScript · Node ≥ 20 · SQLite FTS5 · MIT</sub>

```text
  auto rank=1 30/30   auto Recall@3 30/30   known rank=1 20/20
  315 非负例 300/300 rank1   负例 0/15 误吐
  —— 随仓库附带的合成语料，一条命令可复现
```

</div>

---

## 一眼看懂

```text
  写路径（手动）                              读路径（按需）

  Claude Code   ~/.claude/projects/*.jsonl         ┐
  Codex         ~/.codex/sessions/**/*.jsonl       │
  Qoder         ~/.qoder/projects/**/*.jsonl       │
  pi            ~/.pi/agent/sessions/**/*.jsonl    ├─► 解析 · 分词 ─► mem.db (FTS5)
  opencode      ~/.local/share/opencode/*.db       │   全量语义证据         │
  dsh           ~/.dsh/sessions/**/*.zstd           │                       │
  Antigravity   ~/.gemini/antigravity-cli/brain/** │                       │
                                                   ┘                       │
  notes（显式 remember） ────────────────────────────────────────┐        │
                                                                 ▼        ▼
                                                        IDF 候选 ─► BM25+ 与 10 个乘数
                                                               │
                                                               ▼
                                                       判定门槛（不相关就判空）
                                                               │
                                                               ▼
                                                   问题行 + 结论行（双槽）
                                                               │
                                                               ▼
                                                    ≤2 KB 注入块，带来源、日期与参考标注
```

**存的是证据，给的是记忆。** 数 GB 的原始 transcript 永远不进模型；进入上下文的，是从命中会话里抽出的几行结论。这一层用完即弃，不落盘、不累积、不需要离线维护——与 Mem0 / Zep 的「索引时抽事实」和 Anthropic 的持久化 wiki 都不同。

它不做 LLM 蒸馏，也不写知识库：**保存证据，在查询时生成记忆**。

---

## 快速开始

```bash
# 安装（暂未发布到 npm，从源码安装）
git clone https://github.com/exposir/agent-memory.git
cd agent-memory
npm install
npm link

# 索引历史会话（手动）
mem index

# 召回
mem recall "网关 发版配置"              # ≤2 KB
mem recall "依赖 升级失败" --aggressive # ≤4 KB

# 写一条永久记忆
mem remember "升级 gateway 前必须先跑迁移脚本"

# 回源核对（sid 取自 recall 块，完整不截断）
mem show <sid>

# 快照：每会话一个 JSONL，可进 git、可 diff
mem export --out ~/mem-snapshot
mem restore --from ~/mem-snapshot --db /tmp/mem-restored.db
```

完整命令与选项见 [CLI 参考](docs/cli.md)。

---

## 核心能力

| 能力 | 说明 |
|---|---|
| **全量语义证据** | 每条 user / assistant 文本 + 工具记录都入库，不摘要、不抽样 |
| **零 LLM 调用** | BM25+ 与启发式排序，全部本地 SQLite，成本为零 |
| **跨 agent** | 一次查询跨 Claude Code / Codex / opencode / Qoder / pi / dsh / Antigravity 七个池子 |
| **中文感知** | CJK 二元组索引，不依赖外部分词库；中文 run 顺序错误按语料频次纠正 |
| **查询与证据** | 前缀截断、同长 ASCII/路径段/中文乱序纠错、稀有路径约束、粘贴证据判定、短问句加权 |
| **负例判空** | 无关问题输出空，不拿「最相近的三个」凑数 |
| **零侵入** | 不接管 shell、不加 hook、不改 agent 配置，只装一个 CLI |

---

## 验收

| 口径 | 结果 |
|---|---|
| 官方 50 题（合成语料，冻结时钟） | auto rank=1 `30/30`、Recall@3 `30/30`；known `20/20`；负例 `0/15` |
| 315 题（50 源会话 × 6 问法） | 非负例 rank=1 `300/300`；六类问法全部 `50/50` |
| 复现 | `npm run bench:build && npm run bench:queries && npm run bench:search` |

题库与语料完全合成、随仓库发布；参数在私有真实语料上迭代，边界与口径见 [验收](docs/benchmark.md) 与 [方法调研](docs/methods.md)。

---

## 两个 Skill

| Skill | 触发 | 动作 |
|---|---|---|
| `mem-index` | 仅显式 `/mem-index`，不自动触发 | `mem index` 增量入库；`mem remember` 写显式笔记 |
| `mem-recall` | 模型自动判断并查询，宁可多查一次；也可 `/mem-recall` 手动深查 | 命中则注入 ≤2 KB 历史参考；不命中返回空，当前上下文与工具证据优先 |

**写路径手动，读路径自动触发。** 写路径完全人工维护：不设定时任务、不装后台进程、不加 `UserPromptSubmit` hook。recall 由模型按 skill 描述在相关任务中自动查询，宁可多查一次；返回块只作历史参考，不能取信，当前上下文与工具能验证的证据优先。时效 = 最后一次 `mem index` 的时间。后续若定时，只自动化写路径，调度交给系统 cron，`mem index --quiet` 即可。

---

## 文档

| 文档 | 内容 |
|---|---|
| [设计原则](docs/design.md) | 证据与记忆分离、显著性判据、数据边界 |
| [检索算法](docs/retrieval.md) | Tokenizer、BM25 乘数、判定门槛、双槽与预算 |
| [验收](docs/benchmark.md) | 合成语料评测、题库口径与边界 |
| [方法调研](docs/methods.md) | BM25+ / focused / OOV fallback / 查询归一化 / ASCII·路径段·中文乱序纠错 / 路径约束 / 粘贴 / 直接问句 / 长度上限的 A/B 与未采用方案 |
| [存储架构](docs/storage.md) | SQLite schema、笔记纠错、增量水位 |
| [复刻范围](docs/scope.md) | 抄什么、不抄什么、其他方案取舍 |
| [CLI 参考](docs/cli.md) | 全部命令与选项 |
| [开发](docs/development.md) | 门禁与里程碑状态 |

---

## 边界

- 315 题是同一批源会话上的样本内评测，不是 held-out 泛化证明；官方门禁是其中 original 子集。公开题库跑在合成语料上，验证行为一致性，不代表真实语料的分布。
- 当前指标验证「目标会话排第 1」，不验证注入块里的结论是否完整回答；答案级评测尚未建立人工标注。机械探针显示结论槽常不复述答案词，部分结论会以冒号或省略号截断。
- 在文档归档良好的活跃项目上，盲测显示带记忆反而多花步数：记忆的价值在文档海里的定位与跨 agent 续作交接，不在替代文档纪律。
- 大库的 contentless 索引优化尚未落地；可复现评测依赖冻结时钟。

---

## License

MIT
