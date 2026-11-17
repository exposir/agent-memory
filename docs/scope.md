# 复刻范围：抄什么，不抄什么

以一个成熟的全量索引式会话记忆工具为参照，按「它解决了什么真实问题」逐项判断，而不是按「它有没有」。

| 层 | 做法 | 理由 |
|---|---|---|
| 增量语义（前缀采样、SafeSize、成功后提交 watermark、单实例锁） | **复刻** | 手动重跑与将来定时的并发基础 |
| 全量语义文本 + 工具记录 role 预算 | **复刻** | 召回率的实质来源 |
| IDF 加权排名 + 候选 32 + 降级阶梯 | **复刻** | 严格 AND 在真实 prompt 上大量漏召回 |
| BM25 + 7 个乘数 | **复刻** | 每项都对应一个真实失败案例 |
| 判定门槛（worthShowing + leadTermsMeet） | **复刻** | 属判定，不属防重复；直接决定块里有没有答案 |
| 包装层（双槽、决策标记、replyWindow、跳过词表、预算裁剪） | **全量复刻** | 注入块质量的主要来源 |
| notes 显式记忆 | **复刻并简化** | 零 LLM，1.25×，压过来源；不引入模型写者与 dreaming，但保留 `supersedes` / `written_by` 两列：旧条目可被覆盖，历史保留 |
| 物理格式（records.bin / buckets / overlays / DeadRecords） | **不复刻** | SQLite 已提供崩溃安全、原子提交、并发读，换 0 收益 |
| imported / local 排序维度 | **不复刻** | 单机单人，不存在这个维度 |
| hook 冷却 / 块指纹 / 逐 quote 指纹 / digest 上限 / 20 min 重复注入线 / spawn 谱系 | **不复刻** | 纯防重复注入，手动模式无承载对象 |
| 几十种 harness 适配 / policy-trust / cron 过滤 / usage 统计 / nudge / compaction recovery / 跨机器 sync | **不复刻** | 只接本机 agent、单机、单人 |
| 内置调度器 / daemon | **不复刻** | 调度由系统负责，`--quiet` 足够 |

与其他方案的取舍：

| 方案 | 做法 | 本项目 |
|---|---|---|
| **全量索引 + 自动注入式工具** | 全量索引，查询时抽结论，自动注入 | 采纳检索算法与包装层；去掉自动注入护栏与几十种 harness 的通用性 |
| **Mem0 / Zep** | 索引时 LLM 抽取事实 / 建时序图 | 不采纳：需要 LLM、抽错无法回源 |
| **Anthropic dreaming** | 笔记 + 离线算力重整出 wiki 等持久化表示层 | 不采纳「持久化视图」；视图做成查询时现算、用完即弃 |

Anthropic 2026-11 的研究支持这个分层，但要读全它的结论：

- **transcript search 是 foundation**（原文原话）。我们的证据层就是这一层。
- wiki 的收益是**条件性**的：merger 24 题里过半需跨文档综合，wiki 87% vs search 73%；单文档可检索的 LAB 任务 wiki 无增益，另一次 wiki 甚至长得比原始文档还大（`effectively abstracted nothing`）。
- wiki + search 从 54% 升到 61%（纯 search 53%），但**要 128 轮 dreaming 持续维护**、会写错（多 agent 并发写同一页，57 条合同条款只留下 41 条）、错笔记会被每轮加载。原文明确说表示层「needs to use compute to maintain … and make sure they don't accumulate errors or hallucinations」。

我们的视图不物化，于是维护成本、漂移、纠错调度这三类问题一起消失；`mem show <sid>` 就是原文那句 `The transcript gave Claude a ground truth to validate its memory against` 的落地——注入块带**完整 sid**，任何结论都能回源核对。唯一持久化的笔记只有人能写，所以不需要模型回源重读 transcript。
