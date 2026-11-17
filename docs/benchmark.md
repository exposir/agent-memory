# 验收：合成语料上的可复现评测

本仓库随附一份**完全合成**的会话语料与题库：65 个会话（Claude 22 / Codex 30 / opencode 13）、4 个虚构项目（`/work/acme`、`/work/notes`、`/work/pages`、`/work/sandbox`），由 `bench/build-synthetic.ts` 确定性生成，不含任何真实用户数据。题库结构与真实评测一致：30 个自动正例（25 Codex / 5 Claude）+ 20 个人工已知题 + 15 个 cross-paired 负例；每个正例派生 5 个变体（paraphrase / typo / quoted / code_path / occasion），共 315 个 query case。

## 复现

```bash
npm install
npm run bench:build      # 生成合成语料 + 题库（positives/known/negatives/holder-snapshot/manifest）
npm run bench:queries    # 展开 315 个 query case（queries.json）
npm run bench:validate   # 校验题库：holder 唯一性、负例 cross-pair、checksum
npm run bench:search     # 建 mem.db 并跑官方 50 题门禁（eval-search）
npm run bench:methods    # 跑 315 题全量 + 负例 recall 块判定（eval-methods）
```

时钟冻结在语料 cutoff `2026-01-15T00:00:00Z`（`MEM_EVAL_NOW` 可覆盖，`live` 切回真实时钟）：`freshnessDecay` 依赖墙钟，不冻结的话同一份代码隔天会换名次。

## 结果（合成语料，冻结时钟）

| 口径 | 结果 |
|---|---|
| 官方 50 题（original） | auto rank=1 `30/30`、Recall@3 `30/30`；known rank=1 `20/20`、Recall@3 `20/20` |
| 315 题全量 | positive rank=1 `180/180`、Recall@3 `180/180`；known `120/120`、`120/120` |
| 六类问法 | original / paraphrase / typo / quoted / code_path / occasion 全部 `50/50` |
| 负例（recall 块口径） | `0/15` 非空 |
| 负例（search 跨项目泄漏） | `0/30`（每条负例按两种 project 存储形态各测一次） |
| 延迟 | in-process p50 ≈ 1–2 ms、p95 ≈ 3–5 ms（65 会话小库；真实规模见下） |

## 口径与边界

- **这是合成语料，不是真实 transcript。** 检索算法的每一项参数（BM25+ δ、focused K=8、纠错门槛、各乘数）是在作者的私有真实语料上迭代出来的，本仓库不随附那份语料与其中的数字。合成题库验证的是：代码在公开可复现的输入上，行为与文档描述一致。
- **315 题是样本内评测，不是 held-out 泛化证明。** 50 个源会话 × 6 种问法；所有规则与题库同源。100% 是样本内饱和，不能读作「检索已经解决」。
- **负例必须走 recall 块判定**，不能用 `search` 的命中数代替：有候选但被门槛拒绝，与真正命中是两回事。`eval-methods.ts` 对每条负例跑完整 `buildRecall`，要求输出空。
- 负例的 project 是 cross-paired 定义的一部分（真实问句 × 不含答案的项目）。Claude 会话的 project 存目录编码形态（`-work-acme`），codex/opencode 存原始路径（`/work/acme`）；评测对两种形态各判一次。
- 真实规模的参考数字（私有语料，不可随仓库复现）：约 31 万条消息 / 3.2 GB 库上，倒排 AND 查询 4–5 ms，全表 LIKE 扫描 3.3–6.9 s；首次全量索引约 7 分钟，增量约 17 秒。
- 另一个诚实的边界：在文档归档良好的活跃项目上做过 2×2 盲测（同任务、有/无记忆 × 两种 agent），四组全部答对，**带记忆的组反而多花步数**——记忆的价值在文档海里的定位与跨 agent 续作交接，不在替代良好的文档纪律。