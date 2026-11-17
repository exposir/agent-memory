import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { tokenize } from "../src/tokenize.js";
import { getSession, holderSids } from "./lib/corpus-query.js";
import { BENCH_DIR, DEFAULT_CORPUS_CUTOFF, TMP_DIR } from "./lib/paths.js";

type Agent = "claude" | "codex";

interface Variant {
  kind: "paraphrase" | "typo" | "quoted" | "code_path" | "occasion";
  query: string;
  answerTerms: string[];
}

interface Positive {
  id: string;
  agent: Agent;
  sid: string;
  project: string;
  updated: string | null;
  query: string;
  answerSummary: string;
  answerTerms: string[];
  variants: Variant[];
}

interface PositiveSeed {
  id: string;
  agent: Agent;
  sid: string;
  query: string;
  answerSummary: string;
  codePath: string;
  occasion?: string;
  verificationPhrase?: string;
}

const CODEX_SEEDS: PositiveSeed[] = [
  {
    id: "codex-01-skills-sync",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000001",
    query: "- Codex 当前读取 ~/.agents/skills 那就完全同步到 - Codex 的 ~/.codex/skill 不就好了",
    answerSummary: "把 skills 目录收敛到同一份来源，避免 Codex 读取两套副本。",
    codePath: "~/.codex/skill",
    occasion: "同步 agent 配置时",
  },
  {
    id: "codex-02-pi-join",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000002",
    query: "codex 和 pi 也接入把 默认使用 codex",
    answerSummary: "将 codex 与 pi 接入 peer 路由，并把 codex 设为默认执行方。",
    codePath: "/work/acme",
    occasion: "接入新的 coding agent 时",
  },
  {
    id: "codex-03-nova-data-path",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query:
      "把数据源放到 /work/acme/harness/skills/daily-feed 里面吧",
    answerSummary: "Daily Feed 数据源迁入 harness skill 目录，不再依赖单独的数据仓。",
    codePath: "harness/skills/daily-feed",
    occasion: "整理新闻数据目录时",
  },
  {
    id: "codex-04-nova-news-ts",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query:
      "现在 /work/acme/harness/skills/daily-feed/data/news.ts 这个数据是全棉的吗",
    answerSummary: "核查 news.ts 是否包含完整数据，并确认后续结构化方案。",
    codePath: "harness/skills/daily-feed/data/news.ts",
    occasion: "检查新闻数据完整性时",
  },
  {
    id: "codex-05-nova-json",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query: "数据是不是可以重构或者怎么处理下或者用 json要不然以后数据量大了很尴尬吧",
    answerSummary: "讨论将新闻数据从 TS 字面量迁到 JSON，控制长期体量与维护成本。",
    codePath: "harness/skills/daily-feed/data",
    occasion: "评估数据格式时",
  },
  {
    id: "codex-06-nova-git-config",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query: "那你处理配置下 github 用 dev@example.test 私有仓库 用 acme-dev",
    answerSummary: "按公开 GitHub 与私有仓库分别配置提交身份。",
    codePath: "harness/skills/daily-feed/data",
    occasion: "配置仓库提交身份时",
  },
  {
    id: "codex-07-nova-conflicts",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query:
      "那你看看处理下 可以自由评估处理冲突 然后说不要放到 ~/daily-feed 这个目录 应该放到 harness skill nova-dail 里面",
    answerSummary: "允许自动合并新闻数据冲突，产物落到 harness 的 daily-feed skill。",
    codePath: "harness/skills/daily-feed",
    occasion: "处理新闻数据冲突时",
  },
  {
    id: "codex-08-nova-style",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query: "你这不对啊 样式比之前的粗糙很多 你只改内容 不要改变之前的样式",
    answerSummary: "保持既有页面样式，只更新 Daily Feed 内容。",
    codePath: "harness/skills/daily-feed/data",
    occasion: "更新页面内容时",
  },
  {
    id: "codex-09-nova-schedule",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query: "如果我想用定时任务获取新闻并部署 直接触发 daily-feed 就可以吗",
    answerSummary: "将 daily-feed 作为定时采集与部署入口。",
    codePath: "harness/skills/daily-feed/data",
    occasion: "配置定时新闻任务时",
  },
  {
    id: "codex-10-nova-extract",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000003",
    query: "或者你就把 daily-feed的获取新闻能力提出来不就好了 后续 daily-feed 也用这个能力",
    answerSummary: "把新闻采集能力抽成独立能力，主流程复用同一实现。",
    codePath: "harness/skills/daily-feed",
    occasion: "拆分新闻采集能力时",
  },
  {
    id: "codex-11-technews",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000004",
    query: "technews 以及 newsinsight 是不是更新了",
    answerSummary: "核对 Hacker News 与新闻洞察两类内容的最新更新时间。",
    codePath: "/work/notes",
    occasion: "检查新闻页面更新时",
  },
  {
    id: "codex-12-news-page",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000005",
    query: "tech-news 和 news 更新到网页",
    answerSummary: "将 tech-news 与 news 的最新内容同步到网页。",
    codePath: "/work/notes",
    occasion: "同步新闻到网页时",
  },
  {
    id: "codex-13-nova-running",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000006",
    query:
      "外部写入**还没结束**：15:31 的定时轮仍在跑（`scheduled_task_run_logs` 状态 running），news 侧还持有 `~/.local/state/daily-feed-news/lock`，最新数据已到 1416 条、edition 仍是 01.11 12:16。",
    answerSummary: "确认定时采集仍持有锁，1416 条数据但 edition 尚未推进。",
    codePath: "~/.local/state/daily-feed-news/lock",
    occasion: "排查定时采集卡住时",
  },
  {
    id: "codex-14-billing-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000007",
    query: "独立验证第 1 轮给出了修复清单：out/plan/billing-admin/verify-r1.json。请逐条处理。",
    answerSummary: "按 billing-admin 首轮独立验证清单逐项修复。",
    codePath: "out/plan/billing-admin/verify-r1.json",
    occasion: "处理架构图验证清单时",
  },
  {
    id: "codex-15-paymentservice-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000008",
    query: "独立验证第 1 轮给出了修复清单：out/plan/paymentservice/verify-r1.json。请逐条处理。",
    answerSummary: "按 paymentservice 首轮独立验证清单逐项修复。",
    codePath: "out/plan/paymentservice/verify-r1.json",
    occasion: "处理架构图验证清单时",
  },
  {
    id: "codex-16-gateway-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000009",
    query: "独立验证第 1 轮给出了修复清单：out/plan/gateway/verify-r1.json。请逐条处理。",
    answerSummary: "按 gateway 首轮独立验证清单逐项修复。",
    codePath: "out/plan/gateway/verify-r1.json",
    occasion: "处理架构图验证清单时",
  },
  {
    id: "codex-17-portal-center-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-00000000000a",
    query: "独立验证第 1 轮给出了修复清单：out/plan/portal-center/verify-r1.json。请逐条处理。",
    answerSummary: "按 portal-center 首轮独立验证清单逐项修复。",
    codePath: "out/plan/portal-center/verify-r1.json",
    occasion: "处理架构图验证清单时",
  },
  {
    id: "codex-18-data-platform-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-00000000000b",
    query: "独立验证第 1 轮给出了修复清单：out/plan/data-platform/verify-r1.json。请逐条处理。",
    answerSummary: "按 data-platform 首轮独立验证清单逐项修复。",
    codePath: "out/plan/data-platform/verify-r1.json",
    occasion: "处理架构图验证清单时",
  },
  {
    id: "codex-19-ledger-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-00000000000c",
    query: "独立验证第 2 轮给出了修复清单：out/plan/ledger-ai/verify-r2.json。请逐条处理。",
    answerSummary: "按 ledger-ai 第二轮独立验证清单逐项修复。",
    codePath: "out/plan/ledger-ai/verify-r2.json",
    occasion: "处理第二轮验证清单时",
  },
  {
    id: "codex-20-paymentserviceplus-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-00000000000d",
    query: "独立验证第 2 轮给出了修复清单：out/plan/paymentserviceplus/verify-r2.json。请逐条处理。",
    answerSummary: "按 paymentserviceplus 第二轮独立验证清单逐项修复。",
    codePath: "out/plan/paymentserviceplus/verify-r2.json",
    occasion: "处理第二轮验证清单时",
  },
  {
    id: "codex-21-origix-verify",
    agent: "codex",
    sid: "00000000-0000-4000-8000-00000000000e",
    query: "独立验证第 1 轮给出了修复清单：output/plan/origix/verify-r1.json。请逐条处理。",
    answerSummary: "按 origix 首轮独立验证清单逐项修复。",
    codePath: "output/plan/origix/verify-r1.json",
    occasion: "处理架构图验证清单时",
  },
  {
    id: "codex-22-p0p1",
    agent: "codex",
    sid: "00000000-0000-4000-8000-00000000000f",
    query: "请在当前进度基础上收尾，优先给出已确认的 P0/P1 与行号证据；不必继续扩大范围。",
    answerSummary: "收束审查范围，只报告已确认的 P0/P1 及行号证据。",
    codePath: "/work/acme",
    occasion: "评审收尾时",
  },
  {
    id: "codex-23-p0p1p2",
    agent: "codex",
    sid: "00000000-0000-4000-8000-00000000000f",
    query: "请在当前进度基础上收尾，优先给出已确认的 P0/P1/P2 与行号证据；不必继续扩大范围。",
    answerSummary: "收束审查范围，只报告已确认的 P0/P1/P2 及行号证据。",
    codePath: "/work/acme",
    occasion: "评审收尾时",
  },
  {
    id: "codex-24-billing-verify-2",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000007",
    query: "独立验证第 2 轮给出了修复清单：out/plan/billing-admin/verify-r2.json。请逐条处理。",
    answerSummary: "按 billing-admin 第二轮独立验证清单逐项修复。",
    codePath: "out/plan/billing-admin/verify-r2.json",
    occasion: "处理第二轮验证清单时",
  },
  {
    id: "codex-25-paymentservice-verify-2",
    agent: "codex",
    sid: "00000000-0000-4000-8000-000000000008",
    query: "独立验证第 2 轮给出了修复清单：out/plan/paymentservice/verify-r2.json。请逐条处理。",
    answerSummary: "按 paymentservice 第二轮独立验证清单逐项修复。",
    codePath: "out/plan/paymentservice/verify-r2.json",
    occasion: "处理第二轮验证清单时",
  },
];

const CLAUDE_SEEDS: PositiveSeed[] = [
  {
    id: "claude-01-gateway-models",
    agent: "claude",
    sid: "00000000-0000-4000-8000-000000000010",
    query: "我说的是内部办公网关的 我这里有两个账号 应该分别看看支持哪些模型",
    answerSummary: "区分两个内部办公网关账号各自可用的模型。",
    codePath: "/work/acme/.config/gateway-docker",
    occasion: "核对模型账号时",
  },
  {
    id: "claude-02-star-beyond",
    agent: "claude",
    sid: "00000000-0000-4000-8000-000000000015",
    query: "新增个测试项目 请使用 Three.js 创作一个主题为《星轨之外》的 3D 交互式网页。",
    answerSummary: "创建《星轨之外》Three.js 交互页并纳入生成实测项目。",
    codePath: "/work/pages/public/research/star-beyond-20260109/index.html",
    occasion: "新增 Three.js 项目时",
  },
  {
    id: "claude-03-agent-diff",
    agent: "claude",
    sid: "00000000-0000-4000-8000-000000000012",
    query: "我没看明白这个和 claudecode codex之类的区别是什么",
    answerSummary: "对比 dsh、Claude Code 与 Codex 的架构和扩展方式。",
    codePath: "/work/acme/agents-harness",
    occasion: "比较 coding agent 时",
  },
  {
    id: "claude-04-map-page",
    agent: "claude",
    sid: "00000000-0000-4000-8000-000000000013",
    query: "基于这个图做成一个页面怎么样 目的是仔细介绍古城皇城 样式和这个图片差不多美观 用 GPU 进行页面渲染",
    answerSummary: "围绕古城皇城图制作具备 GPU 渲染效果介绍页面。",
    codePath: "/work/pages/assets/古城皇城导览图.png",
    occasion: "制作历史地图页面时",
  },
  {
    id: "claude-05-terminal-app",
    agent: "claude",
    sid: "00000000-0000-4000-8000-000000000014",
    query: "AI coding agent 设计的桌面终端 到底是终端还是 app",
    answerSummary: "讨论 AI coding agent 桌面客户端的产品形态与终端边界。",
    codePath: "~/.agents/skills",
    occasion: "讨论终端产品形态时",
  },
];

const KNOWN_SEEDS: Array<{
  id: string;
  query: string;
  sid: string;
  agent: Agent;
  answerSummary: string;
  codePath: string;
  verificationPhrase?: string;
}> = [
  {
    id: "known-01-gateway-upgrade",
    query: "gateway 升级 0.1.3727",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "gateway 从 v0.1.2557 升到 v0.1.3727，容器健康且模型调用通过。",
    codePath: "/work/acme/.config/gateway-docker",
    verificationPhrase:
      "gateway 升级 0.1.3727 gateway-claude v0.1.2557 sha256:7816c4e0 700 个 release",
  },
  {
    id: "known-02-time-end-internal-pages",
    query: "星轨之外 入口 收敛 internal-pages",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "删除《星轨之外》公网入口，统一跳转到 internal-pages 的十五路实测页。",
    codePath: "functions/_middleware.js",
    verificationPhrase:
      "星轨之外 入口 收敛 internal-pages star-beyond-20260109 star-beyond RETIRED private/research/star-beyond-20260109",
  },
  {
    id: "known-03-star-beyond-score",
    query: "star-beyond codex DeepSeek Flash Max 1M 评分",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "评测页新增 codex · DeepSeek Flash Max 1M，评分 97/100。",
    codePath: "/work/pages/public/research/deepseek-provider-quality-20261106/data.json",
  },
  {
    id: "known-04-opencode-gateway",
    query: "opencode Mac 切换 gateway deepseek group",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "Mac opencode 切到 gateway deepseek group，配置与冒烟验证通过。",
    codePath: "/work/acme/.config/opencode/opencode.jsonc",
    verificationPhrase: "opencode Mac 切换 gateway deepseek group 1.19.5 pure 冒烟",
  },
  {
    id: "known-05-recallkit-storage",
    query: "recallkit recallkit-dev 存记忆在哪 索引怎么建",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "原始会话留在各 agent 目录，recallkit 建可重建索引，显式记忆写 notes。",
    codePath: "~/.local/share/recallkit/notes.jsonl",
    verificationPhrase: "recallkit recallkit-dev 0.7 43 agents 4% local/share/recallkit/notes.jsonl",
  },
  {
    id: "known-06-agent-memory",
    query: "agent-memory github 公开仓库 README",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "新建 exposir/agent-memory 公开仓库并写入 FTS5 检索设计。",
    codePath: "/work/acme/README.md",
    verificationPhrase:
      "agent-memory github 公开仓库 README github.com/exposir/agent-memory.git",
  },
  {
    id: "known-07-release-cadence",
    query: "gateway 多久发版一次 106",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "近 7 天约 700 个 release，日均约 106 个，中位间隔 7.3 分钟。",
    codePath: "/work/acme/.config/gateway-docker",
    verificationPhrase: "gateway 多久发版一次 106 700 个 release 日均 106 7.3 分钟",
  },
  {
    id: "known-08-codex-schema",
    query: "Codex session rollout jsonl item_completed 格式",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "Codex rollout 从 event_msg/item_completed 提取 UserMessage 与 AgentMessage。",
    codePath: "~/.codex/sessions",
    verificationPhrase:
      "Codex session rollout jsonl item_completed 格式 UserMessage AgentMessage CommandExecution event_msg payload.item.type",
  },
  {
    id: "known-09-wrangler-workerd",
    query: "wrangler npx cache darwin workerd 权限",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "共享 npx 缓存误含 darwin workerd，Linux 侧改用隔离 npm cache。",
    codePath: "~/.npm/_npx/synthetic-cache",
    verificationPhrase:
      "wrangler npx cache darwin workerd 权限 workerd-darwin-arm64 linux arm64",
  },
  {
    id: "known-10-cf-retired",
    query: "CF 页面 301 旧地址 _middleware RETIRED",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "旧页删除后仍命中边缘缓存，middleware 增加 RETIRED 前缀 301。",
    codePath: "functions/_middleware.js",
    verificationPhrase:
      "CF 页面 301 旧地址 middleware RETIRED research/star-beyond s-maxage tombstone",
  },
  {
    id: "known-11-internal-pages-worktree",
    query: "internal-pages is_internal-pages_repo .git 目录 worktree",
    sid: "00000000-0000-4000-8000-000000000016",
    agent: "claude",
    answerSummary: "is_internal-pages_repo 通过 .git 目录判断仓库类型，部署在独立 worktree 完成。",
    codePath: "skills/page-deploy/scripts/hosts.py",
    verificationPhrase:
      "internal-pages is_internal-pages_repo .git 目录 worktree fix/deploy-internal-pages-cf-worktree hosts.py:64",
  },
  {
    id: "known-12-fts5-trigram",
    query: "SQLite FTS5 trigram 中文 2 字 时间",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "trigram 无法覆盖两字中文，最终采用 CJK 二元组加预分词索引。",
    codePath: "/work/acme/memlib/tokenize.py",
  },
  {
    id: "known-13-jieba",
    query: "jieba 0.42.1 FTS5 中文分词",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "jieba 方案验证过，但 TS 版不引入 Python 分词运行时依赖。",
    codePath: "/work/acme/memlib/tokenize.py",
  },
  {
    id: "known-14-anthropic-memory",
    query: "Anthropic components of agent memory dreaming 413 文件",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "记忆研究支持 transcript search 为基础，但无差别记录会拖慢任务。",
    codePath: "/work/acme/PLAN.md",
  },
  {
    id: "known-15-recallkit-cooldown",
    query: "recallkit hook-prompt 20 分钟 cooldown",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "recallkit 的自动注入用冷却、块指纹和 seen 状态控制重复。",
    codePath: "/work/recallkit/src/prompt/prompt.go",
  },
  {
    id: "known-16-bm25",
    query: "BM25 decisionBoost 2.0 promotedNoteBoost 1.25",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "复刻 BM25 常数与 decisionBoost、promotedNoteBoost 等加权乘数。",
    codePath: "/work/acme/PLAN.md",
  },
  {
    id: "known-17-assistant-plugin",
    query: "内部助手插件 高风险软件 卸载",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "内部助手插件桌面插件通过 CDP 驱动 App，并记录高风险软件处置。",
    codePath: "/Applications/InternalAssistant.app",
  },
  {
    id: "known-18-agy-default",
    query: "agy 默认模型 星",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "agy 原生登录态当时默认使用 Gemini 4 Argon (Medium)。",
    codePath: "/work/acme/.gemini/antigravity-cli/settings.json",
    verificationPhrase:
      "agy 现在的默认模型是什么 原生登录态 Gemini 4 Argon Medium 默认 native model",
  },
  {
    id: "known-19-agy-auth-plugin",
    query: "opencode-agy-cli-auth 插件",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "评估 opencode-agy-cli-auth 将本机 agy CLI 接成 gateway provider。",
    codePath:
      "/work/acme/.config/gateway/plugin-providers.json",
  },
  {
    id: "known-20-assistant-block",
    query: "InternalAssistant.app 高风险软件阻断提醒",
    sid: "00000000-0000-4000-8000-000000000015",
    agent: "claude",
    answerSummary: "InternalAssistant.app 被高风险软件策略阻断，记录了安装与移除路径。",
    codePath: "/Applications/InternalAssistant.app",
  },
];

const NEGATIVE_SEEDS = [
  ["今天中午吃的红烧肉放了几颗八角", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["Daily Feed data/news.ts 用 json 重构", "00000000-0000-4000-8000-000000000003", "/work/sandbox"],
  ["technews 以及 newsinsight 是不是更新了", "00000000-0000-4000-8000-000000000004", "/work/notes"],
  ["quality-round1 1024 32px 单测 56/56", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["cat2 union-all-circles 半径比 14.88", "00000000-0000-4000-8000-000000000015", "/work/notes"],
  ["reader-body-layout 左栏 reader-file-rail 拖拽调宽", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["scripts/subset-fonts usage.json Unicode-range Latin Extended-A", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["a-coast-overview.png 679KB step=6 win=81", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["tools/prep.py map_north.png survey_west.tif", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["scheduled_task_run_logs daily-feed 1416 edition", "00000000-0000-4000-8000-000000000006", "/work/pages"],
  ["internal-pages 工作项 10000001 当前状态 流转条件", "00000000-0000-4000-8000-000000000016", "/work/sandbox"],
  ["CF 页面 301 旧地址 _middleware RETIRED", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["agy 默认模型 星", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["InternalAssistant.app 高风险软件阻断提醒", "00000000-0000-4000-8000-000000000015", "/work/sandbox"],
  ["recallkit recallkit-dev 存记忆在哪 索引怎么建", "00000000-0000-4000-8000-000000000015", "/work/pages"],
] as const;

const STOP_PARAPHRASE = new Set(["the", "a", "an", "please", "please"]);

function tokenSet(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function holderKey(terms: string[]): string {
  return createHash("sha256").update([...new Set(terms)].sort().join("\u0000")).digest("hex");
}

function makeTypo(query: string): string {
  const word = query.match(/[A-Za-z][A-Za-z0-9_./-]{3,}/)?.[0];
  if (!word) {
    return query.replace(/([一-鿿])([一-鿿])/, "$2$1");
  }
  const index = Math.max(1, Math.floor(word.length / 2));
  const replacement = word[index]?.toLowerCase() === "e" ? "a" : "e";
  const typo = `${word.slice(0, index)}${replacement}${word.slice(index + 1)}`;
  return query.replace(word, typo);
}

function makeParaphrase(query: string): string {
  let result = query
    .replaceAll("是不是", "是否")
    .replaceAll("怎么处理", "如何处理")
    .replaceAll("请逐条处理", "请按清单逐项修复")
    .replaceAll("当前状态", "现在的状态")
    .replaceAll("我想用", "能否用");
  if (result === query) {
    if (/[?？]\s*$/.test(result)) {
      result = result.replace(/[?？]\s*$/, "，应该怎么理解？");
    } else {
      result = `想确认一下：${result}`;
    }
  }
  return result;
}

function quotePhrase(query: string, terms: string[]): string {
  const anchor = [...terms]
    .filter((term) => !STOP_PARAPHRASE.has(term))
    .sort((left, right) => right.length - left.length)[0];
  if (!anchor || !query.includes(anchor)) {
    return `“${query}”`;
  }
  return query.replace(anchor, `“${anchor}”`);
}

function variantsFor(seed: PositiveSeed, baseTerms: string[]): Variant[] {
  const typoTerm = makeTypo(seed.query);
  return [
    { kind: "paraphrase", query: makeParaphrase(seed.query), answerTerms: baseTerms },
    { kind: "typo", query: typoTerm, answerTerms: baseTerms },
    { kind: "quoted", query: quotePhrase(seed.query, baseTerms), answerTerms: baseTerms },
    {
      kind: "code_path",
      query: `${seed.query}（相关路径：${seed.codePath}）`,
      answerTerms: baseTerms,
    },
    {
      kind: "occasion",
      query: `${seed.occasion ?? "查询历史记录时"}：${seed.query}`,
      answerTerms: baseTerms,
    },
  ];
}

function seedToPositive(seed: PositiveSeed, db: Database.Database): Positive {
  const session = getSession(db, seed.sid);
  if (!session) {
    throw new Error(`missing session ${seed.sid} for ${seed.id}`);
  }
  const baseTerms = seed.verificationPhrase
    ? tokenSet(seed.verificationPhrase)
    : tokenSet(seed.query);
  const holders = holderSids(db, baseTerms);
  if (holders.length !== 1 || holders[0] !== seed.sid) {
    throw new Error(
      `${seed.id}: expected exactly ${seed.sid}, got ${holders.length} holders: ${holders.slice(0, 5).join(", ")}`,
    );
  }
  return {
    id: seed.id,
    agent: seed.agent,
    sid: seed.sid,
    project: session.project,
    updated: session.updated,
    query: seed.query,
    answerSummary: seed.answerSummary,
    answerTerms: baseTerms,
    variants: variantsFor(seed, baseTerms),
  };
}

function hashObject(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(name: string, value: unknown): string {
  const path = join(BENCH_DIR, name);
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
  return hashObject(path);
}

function main(): void {
  const db = new Database(join(TMP_DIR, "corpus.db"), { readonly: true, fileMustExist: true });
  const positives = [...CODEX_SEEDS, ...CLAUDE_SEEDS].map((seed) => seedToPositive(seed, db));
  const known = KNOWN_SEEDS.map((seed) => seedToPositive(seed, db));
  const holders: Record<string, { terms: string[]; holders: string[] }> = {};
  for (const record of [...positives, ...known]) {
    const terms = [...new Set(record.answerTerms)];
    const key = holderKey(terms);
    holders[key] ??= { terms, holders: holderSids(db, terms) };
  }

  const negatives = NEGATIVE_SEEDS.map(([query, sourceSid, project], index) => {
    const source = getSession(db, sourceSid);
    if (!source) {
      throw new Error(`negative source missing: ${sourceSid}`);
    }
    if (source.project === project) {
      throw new Error(`negative target equals answer project: ${query}`);
    }
    const projectSessions = db
      .prepare("SELECT count(*) AS n FROM sessions WHERE project = ?")
      .get(project) as { n: number };
    if (projectSessions.n === 0) {
      throw new Error(`negative target project has no sessions: ${project}`);
    }
    const sourceInTarget = db
      .prepare("SELECT count(*) AS n FROM sessions WHERE project = ? AND sid = ?")
      .get(project, sourceSid) as { n: number };
    if (sourceInTarget.n !== 0) {
      throw new Error(`negative source session exists in target project: ${query}`);
    }
    const overlap = db
      .prepare(
        `SELECT max(overlap) AS overlap FROM (
           SELECT count(DISTINCT p.term) AS overlap
           FROM sessions s
           JOIN postings p ON p.sid = s.sid
           WHERE s.project = ? AND p.term IN (SELECT value FROM json_each(?))
           GROUP BY s.sid
         )`,
      )
      .get(project, JSON.stringify(tokenize(query))) as { overlap: number | null };
    if ((overlap.overlap ?? 0) < 2) {
      throw new Error(`negative target project has no meaningful lexical overlap: ${query}`);
    }
    return {
      id: `negative-${String(index + 1).padStart(2, "0")}`,
      query,
      sourceSid,
      project,
      sourceProject: source.project,
      targetSessionCount: projectSessions.n,
      overlapHighWatermark: overlap.overlap,
      sourceInTarget: false,
      crossPairVerified: true,
    };
  });

  const positiveDoc = {
    schemaVersion: 1,
    corpusCutoff: DEFAULT_CORPUS_CUTOFF,
    count: positives.length,
    byAgent: {
      codex: positives.filter((item) => item.agent === "codex").length,
      claude: positives.filter((item) => item.agent === "claude").length,
    },
    records: positives,
  };
  const knownDoc = {
    schemaVersion: 1,
    corpusCutoff: DEFAULT_CORPUS_CUTOFF,
    count: known.length,
    records: known,
  };
  const negativeDoc = {
    schemaVersion: 1,
    count: negatives.length,
    records: negatives,
  };
  const holderDoc = {
    schemaVersion: 1,
    corpusCutoff: DEFAULT_CORPUS_CUTOFF,
    entries: holders,
  };

  const hashes = {
    "positives.json": writeJson("positives.json", positiveDoc),
    "known.json": writeJson("known.json", knownDoc),
    "negatives.json": writeJson("negatives.json", negativeDoc),
    "holder-snapshot.json": writeJson("holder-snapshot.json", holderDoc),
  };
  const manifest = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    corpusCutoff: DEFAULT_CORPUS_CUTOFF,
    counts: {
      positives: positives.length,
      codex: positiveDoc.byAgent.codex,
      claude: positiveDoc.byAgent.claude,
      variants: positives.reduce((total, item) => total + item.variants.length, 0),
      known: known.length,
      negatives: negatives.length,
      holderEntries: Object.keys(holders).length,
    },
    sha256: hashes,
  };
  writeJson("manifest.json", manifest);
  db.close();
  console.log(JSON.stringify(manifest, null, 2));
}

main();
