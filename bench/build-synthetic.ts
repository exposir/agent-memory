import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import Database from "better-sqlite3";

import { tokenize } from "../src/tokenize.js";
import { BENCH_DIR, TMP_DIR } from "./lib/paths.js";

// Synthetic corpus: every session, prompt, path and identifier below is
// invented. No real user transcript is read or embedded. The generator is
// deterministic so the frozen bench JSONs can be rebuilt byte-for-byte.

const CUTOFF = "2026-01-15T00:00:00.000Z";
const BASE_MS = Date.parse("2026-01-10T08:00:00.000Z");

interface SessionSpec {
  sid: string;
  agent: "claude" | "codex" | "opencode";
  project: string;
  title: string;
  messages: Array<{ role: "user" | "assistant"; text: string }>;
}

function sid(n: number): string {
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

function ts(offsetMinutes: number): string {
  return new Date(BASE_MS + offsetMinutes * 60_000).toISOString();
}

// Each positive/known seed owns one session whose user prompt is the query.
// The assistant reply carries the answer terms. Filler sessions give the
// corpus realistic IDF spread without touching any seed's unique terms.
const SEED_SESSIONS: SessionSpec[] = [
  {
    sid: "00000000-0000-4000-8000-000000000001", agent: "codex", project: "/work/acme",
    title: "codex-01-skills-sync",
    messages: [
      { role: "user", text: "- Codex 当前读取 ~/.agents/skills 那就完全同步到 - Codex 的 ~/.codex/skill 不就好了" },
      { role: "assistant", text: "决定：- Codex 当前读取 ~/.agents/skills 那就完全同步到 - Codex 的 ~/.codex/skill 不就好了" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000002", agent: "codex", project: "/work/acme",
    title: "codex-02-pi-join",
    messages: [
      { role: "user", text: "codex 和 pi 也接入把 默认使用 codex" },
      { role: "assistant", text: "决定：codex 和 pi 也接入把 默认使用 codex" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000003", agent: "codex", project: "/work/acme",
    title: "codex-03-nova-data-path",
    messages: [
      { role: "user", text: "把数据源放到 /work/acme/harness/skills/daily-feed 里面吧" },
      { role: "assistant", text: "决定：把数据源放到 /work/acme/harness/skills/daily-feed 里面吧" },
      { role: "user", text: "现在 /work/acme/harness/skills/daily-feed/data/news.ts 这个数据是全棉的吗" },
      { role: "assistant", text: "决定：现在 /work/acme/harness/skills/daily-feed/data/news.ts 这个数据是全棉的吗" },
      { role: "user", text: "数据是不是可以重构或者怎么处理下或者用 json要不然以后数据量大了很尴尬吧" },
      { role: "assistant", text: "决定：数据是不是可以重构或者怎么处理下或者用 json要不然以后数据量大了很尴尬吧" },
      { role: "user", text: "那你处理配置下 github 用 dev@example.test 私有仓库 用 acme-dev" },
      { role: "assistant", text: "决定：那你处理配置下 github 用 dev@example.test 私有仓库 用 acme-dev" },
      { role: "user", text: "那你看看处理下 可以自由评估处理冲突 然后说不要放到 ~/daily-feed 这个目录 应该放到 harness skill nova-dail 里面" },
      { role: "assistant", text: "决定：那你看看处理下 可以自由评估处理冲突 然后说不要放到 ~/daily-feed 这个目录 应该放到 harness skill nova-dail 里面" },
      { role: "user", text: "你这不对啊 样式比之前的粗糙很多 你只改内容 不要改变之前的样式" },
      { role: "assistant", text: "决定：你这不对啊 样式比之前的粗糙很多 你只改内容 不要改变之前的样式" },
      { role: "user", text: "如果我想用定时任务获取新闻并部署 直接触发 daily-feed 就可以吗" },
      { role: "assistant", text: "决定：如果我想用定时任务获取新闻并部署 直接触发 daily-feed 就可以吗" },
      { role: "user", text: "或者你就把 daily-feed的获取新闻能力提出来不就好了 后续 daily-feed 也用这个能力" },
      { role: "assistant", text: "决定：或者你就把 daily-feed的获取新闻能力提出来不就好了 后续 daily-feed 也用这个能力" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000004", agent: "codex", project: "/work/sandbox",
    title: "codex-11-technews",
    messages: [
      { role: "user", text: "technews 以及 newsinsight 是不是更新了" },
      { role: "assistant", text: "决定：technews 以及 newsinsight 是不是更新了" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000005", agent: "codex", project: "/work/notes",
    title: "codex-12-news-page",
    messages: [
      { role: "user", text: "tech-news 和 news 更新到网页" },
      { role: "assistant", text: "决定：tech-news 和 news 更新到网页" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000006", agent: "codex", project: "/work/acme",
    title: "codex-13-nova-running",
    messages: [
      { role: "user", text: "外部写入**还没结束**：15:31 的定时轮仍在跑（`scheduled_task_run_logs` 状态 running），news 侧还持有 `~/.local/state/daily-feed-news/lock`，最新数据已到 1416 条、edition 仍是 01.11 12:16。" },
      { role: "assistant", text: "决定：外部写入**还没结束**：15:31 的定时轮仍在跑（`scheduled_task_run_logs` 状态 running），news 侧还持有 `~/.local/state/daily-feed-news/lock`，最新数据已到 1416 条、edition 仍是 01.11 12:16。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000007", agent: "codex", project: "/work/acme",
    title: "codex-14-billing-verify",
    messages: [
      { role: "user", text: "独立验证第 1 轮给出了修复清单：out/plan/billing-admin/verify-r1.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 1 轮给出了修复清单：out/plan/billing-admin/verify-r1.json。请逐条处理。" },
      { role: "user", text: "独立验证第 2 轮给出了修复清单：out/plan/billing-admin/verify-r2.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 2 轮给出了修复清单：out/plan/billing-admin/verify-r2.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000008", agent: "codex", project: "/work/acme",
    title: "codex-15-paymentservice-verify",
    messages: [
      { role: "user", text: "独立验证第 1 轮给出了修复清单：out/plan/paymentservice/verify-r1.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 1 轮给出了修复清单：out/plan/paymentservice/verify-r1.json。请逐条处理。" },
      { role: "user", text: "独立验证第 2 轮给出了修复清单：out/plan/paymentservice/verify-r2.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 2 轮给出了修复清单：out/plan/paymentservice/verify-r2.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000009", agent: "codex", project: "/work/acme",
    title: "codex-16-gateway-verify",
    messages: [
      { role: "user", text: "独立验证第 1 轮给出了修复清单：out/plan/gateway/verify-r1.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 1 轮给出了修复清单：out/plan/gateway/verify-r1.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-00000000000a", agent: "codex", project: "/work/acme",
    title: "codex-17-portal-center-verify",
    messages: [
      { role: "user", text: "独立验证第 1 轮给出了修复清单：out/plan/portal-center/verify-r1.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 1 轮给出了修复清单：out/plan/portal-center/verify-r1.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-00000000000b", agent: "codex", project: "/work/acme",
    title: "codex-18-data-platform-verify",
    messages: [
      { role: "user", text: "独立验证第 1 轮给出了修复清单：out/plan/data-platform/verify-r1.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 1 轮给出了修复清单：out/plan/data-platform/verify-r1.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-00000000000c", agent: "codex", project: "/work/acme",
    title: "codex-19-ledger-verify",
    messages: [
      { role: "user", text: "独立验证第 2 轮给出了修复清单：out/plan/ledger-ai/verify-r2.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 2 轮给出了修复清单：out/plan/ledger-ai/verify-r2.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-00000000000d", agent: "codex", project: "/work/acme",
    title: "codex-20-paymentserviceplus-verify",
    messages: [
      { role: "user", text: "独立验证第 2 轮给出了修复清单：out/plan/paymentserviceplus/verify-r2.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 2 轮给出了修复清单：out/plan/paymentserviceplus/verify-r2.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-00000000000e", agent: "codex", project: "/work/acme",
    title: "codex-21-origix-verify",
    messages: [
      { role: "user", text: "独立验证第 1 轮给出了修复清单：output/plan/origix/verify-r1.json。请逐条处理。" },
      { role: "assistant", text: "决定：独立验证第 1 轮给出了修复清单：output/plan/origix/verify-r1.json。请逐条处理。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-00000000000f", agent: "codex", project: "/work/acme",
    title: "codex-22-p0p1",
    messages: [
      { role: "user", text: "请在当前进度基础上收尾，优先给出已确认的 P0/P1 与行号证据；不必继续扩大范围。" },
      { role: "assistant", text: "决定：请在当前进度基础上收尾，优先给出已确认的 P0/P1 与行号证据；不必继续扩大范围。" },
      { role: "user", text: "请在当前进度基础上收尾，优先给出已确认的 P0/P1/P2 与行号证据；不必继续扩大范围。" },
      { role: "assistant", text: "决定：请在当前进度基础上收尾，优先给出已确认的 P0/P1/P2 与行号证据；不必继续扩大范围。" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000010", agent: "claude", project: "/work/acme",
    title: "claude-01-gateway-models",
    messages: [
      { role: "user", text: "我说的是内部办公网关的 我这里有两个账号 应该分别看看支持哪些模型" },
      { role: "assistant", text: "决定：我说的是内部办公网关的 我这里有两个账号 应该分别看看支持哪些模型" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000015", agent: "claude", project: "/work/acme",
    title: "claude-02-star-beyond",
    messages: [
      { role: "user", text: "新增个测试项目 请使用 Three.js 创作一个主题为《星轨之外》的 3D 交互式网页。" },
      { role: "assistant", text: "决定：新增个测试项目 请使用 Three.js 创作一个主题为《星轨之外》的 3D 交互式网页。" },
      { role: "user", text: "gateway 升级 0.1.3727" },
      { role: "assistant", text: "gateway 升级 0.1.3727 gateway-claude v0.1.2557 sha256:7816c4e0 700 个 release" },
      { role: "user", text: "星轨之外 入口 收敛 internal-pages" },
      { role: "assistant", text: "星轨之外 入口 收敛 internal-pages star-beyond-20260109 star-beyond RETIRED private/research/star-beyond-20260109" },
      { role: "user", text: "star-beyond codex DeepSeek Flash Max 1M 评分" },
      { role: "assistant", text: "决定：star-beyond codex DeepSeek Flash Max 1M 评分" },
      { role: "user", text: "opencode Mac 切换 gateway deepseek group" },
      { role: "assistant", text: "opencode Mac 切换 gateway deepseek group 1.19.5 pure 冒烟" },
      { role: "user", text: "recallkit recallkit-dev 存记忆在哪 索引怎么建" },
      { role: "assistant", text: "recallkit recallkit-dev 0.7 43 agents 4% local/share/recallkit/notes.jsonl" },
      { role: "user", text: "agent-memory github 公开仓库 README" },
      { role: "assistant", text: "agent-memory github 公开仓库 README github.com/exposir/agent-memory.git" },
      { role: "user", text: "gateway 多久发版一次 106" },
      { role: "assistant", text: "gateway 多久发版一次 106 700 个 release 日均 106 7.3 分钟" },
      { role: "user", text: "Codex session rollout jsonl item_completed 格式" },
      { role: "assistant", text: "Codex session rollout jsonl item_completed 格式 UserMessage AgentMessage CommandExecution event_msg payload.item.type" },
      { role: "user", text: "wrangler npx cache darwin workerd 权限" },
      { role: "assistant", text: "wrangler npx cache darwin workerd 权限 workerd-darwin-arm64 linux arm64" },
      { role: "user", text: "CF 页面 301 旧地址 _middleware RETIRED" },
      { role: "assistant", text: "CF 页面 301 旧地址 middleware RETIRED research/star-beyond s-maxage tombstone" },
      { role: "user", text: "SQLite FTS5 trigram 中文 2 字 时间" },
      { role: "assistant", text: "决定：SQLite FTS5 trigram 中文 2 字 时间" },
      { role: "user", text: "jieba 0.42.1 FTS5 中文分词" },
      { role: "assistant", text: "决定：jieba 0.42.1 FTS5 中文分词" },
      { role: "user", text: "Anthropic components of agent memory dreaming 413 文件" },
      { role: "assistant", text: "决定：Anthropic components of agent memory dreaming 413 文件" },
      { role: "user", text: "recallkit hook-prompt 20 分钟 cooldown" },
      { role: "assistant", text: "决定：recallkit hook-prompt 20 分钟 cooldown" },
      { role: "user", text: "BM25 decisionBoost 2.0 promotedNoteBoost 1.25" },
      { role: "assistant", text: "决定：BM25 decisionBoost 2.0 promotedNoteBoost 1.25" },
      { role: "user", text: "内部助手插件 高风险软件 卸载" },
      { role: "assistant", text: "决定：内部助手插件 高风险软件 卸载" },
      { role: "user", text: "agy 默认模型 星" },
      { role: "assistant", text: "agy 现在的默认模型是什么 原生登录态 Gemini 4 Argon Medium 默认 native model" },
      { role: "user", text: "opencode-agy-cli-auth 插件" },
      { role: "assistant", text: "决定：opencode-agy-cli-auth 插件" },
      { role: "user", text: "InternalAssistant.app 高风险软件阻断提醒" },
      { role: "assistant", text: "决定：InternalAssistant.app 高风险软件阻断提醒" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000012", agent: "claude", project: "/work/acme",
    title: "claude-03-agent-diff",
    messages: [
      { role: "user", text: "我没看明白这个和 claudecode codex之类的区别是什么" },
      { role: "assistant", text: "决定：我没看明白这个和 claudecode codex之类的区别是什么" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000013", agent: "claude", project: "/work/pages",
    title: "claude-04-map-page",
    messages: [
      { role: "user", text: "基于这个图做成一个页面怎么样 目的是仔细介绍古城皇城 样式和这个图片差不多美观 用 GPU 进行页面渲染" },
      { role: "assistant", text: "决定：基于这个图做成一个页面怎么样 目的是仔细介绍古城皇城 样式和这个图片差不多美观 用 GPU 进行页面渲染" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000014", agent: "claude", project: "/work/acme",
    title: "claude-05-terminal-app",
    messages: [
      { role: "user", text: "AI coding agent 设计的桌面终端 到底是终端还是 app" },
      { role: "assistant", text: "决定：AI coding agent 设计的桌面终端 到底是终端还是 app" },
    ],
  },
  {
    sid: "00000000-0000-4000-8000-000000000016", agent: "claude", project: "/work/acme",
    title: "known-11-internal-pages-worktree",
    messages: [
      { role: "user", text: "internal-pages is_internal-pages_repo .git 目录 worktree" },
      { role: "assistant", text: "internal-pages is_internal-pages_repo .git 目录 worktree fix/deploy-internal-pages-cf-worktree hosts.py:64" },
    ],
  },
];


// Negative-anchor sessions: one per target project. Each carries the lexical
// terms of the negatives aimed at that project (so cross-pair overlap >= 2),
// but never a seed's full query, keeping positive holders unique.
const NEGATIVE_ANCHORS: SessionSpec[] = [
  {
    sid: sid(300), agent: "claude", project: "/work/sandbox", title: "sandbox 杂项",
    messages: [
      { role: "user", text: "今天中午吃的红烧肉放了几颗八角，味道不错。" },
      { role: "assistant", text: "Ran: grep -n 八角 lunch.log\nOutput: 红烧肉 八角 各一处，仅日志提及，无法继续定位来源。" },
      { role: "user", text: "quality-round1 的单测过了吗？" },
      { role: "assistant", text: "Ran: npm test -- quality-round1\nOutput: 环境缺依赖，无法执行 quality-round1 的单测。" },
      { role: "user", text: "reader-body-layout 的左栏宽度怎么调？" },
      { role: "assistant", text: "Read: src/reader-body-layout.css\n没有权限修改该文件，reader-body-layout 左栏宽度调整被阻止。" },
      { role: "user", text: "scripts/subset-fonts 的 usage.json 里 Unicode-range 怎么配？" },
      { role: "assistant", text: "Ran: cat scripts/subset-fonts/usage.json\nOutput: 文件不存在，Unicode-range 配置无法继续。" },
      { role: "user", text: "a-coast-overview.png 有 679KB，能压吗？" },
      { role: "assistant", text: "Ran: ls -la a-coast-overview.png\nOutput: 679KB 确认，但压缩工具 permission denied，无法执行。" },
      { role: "user", text: "tools/prep.py 读 map_north.png 报错了。" },
      { role: "assistant", text: "Ran: python tools/prep.py map_north.png\nOutput: permission denied，prep.py 无法继续读取。" },
      { role: "user", text: "internal-pages 的工作项 10000001 现在什么状态？" },
      { role: "assistant", text: "Ran: curl internal-pages/api/items/10000001\nOutput: 没有权限访问该接口，10000001 状态无法继续查询。" },
      { role: "user", text: "CF 页面 301 之后旧地址还能访问吗？" },
      { role: "assistant", text: "Ran: curl -I https://example.test/old\nOutput: call blocked，CF 页面 301 旧地址探测无法执行。" },
      { role: "user", text: "agy 的默认模型是哪个？" },
      { role: "assistant", text: "Ran: agy config get\nOutput: not permitted，agy 默认模型配置无法继续读取。" },
      { role: "user", text: "InternalAssistant.app 弹了个提醒，要紧吗？" },
      { role: "assistant", text: "Read: /Applications/InternalAssistant.app/Contents/Info.plist\n权限不足，InternalAssistant.app 的提醒内容无法继续核实。" },
    ],
  },
  {
    sid: sid(301), agent: "codex", project: "/work/acme", title: "acme 杂项",
    messages: [
      { role: "user", text: "Daily Feed 的 data/news.ts 考虑用 json 重构，quality-round1 1024 32px 单测 56/56。" },
      { role: "assistant", text: "记录：Daily Feed news.ts json 重构方案 quality-round1 1024 32px 单测 56/56。" },
      { role: "user", text: "reader-body-layout 左栏 reader-file-rail 拖拽调宽，scripts/subset-fonts usage.json Unicode-range Latin Extended-A。" },
      { role: "assistant", text: "记录：reader-body-layout reader-file-rail 拖拽 subset-fonts usage.json Unicode-range Latin Extended-A。" },
      { role: "user", text: "a-coast-overview.png 679KB step=6 win=81，tools/prep.py map_north.png survey_west.tif，内部助手应用被策略拦截的提醒。" },
      { role: "assistant", text: "记录：a-coast-overview.png 679KB step=6 win=81 prep.py map_north.png survey_west.tif 内部助手 策略 拦截 提醒。" },
    ],
  },
  {
    sid: sid(302), agent: "claude", project: "/work/notes", title: "notes 杂项",
    messages: [
      { role: "user", text: "cat2 的 union-all-circles 半径比是多少来着？" },
      { role: "assistant", text: "Ran: python cat2/circles.py\nOutput: 缺少数值输入，union-all-circles 半径比无法继续计算。" },
      { role: "user", text: "technews 页面是不是更新过？" },
      { role: "assistant", text: "Ran: curl technews.example.test\nOutput: call blocked，technews 页面更新情况无法执行核对。" },
    ],
  },
  {
    sid: sid(303), agent: "codex", project: "/work/pages", title: "pages 杂项",
    messages: [
      { role: "user", text: "scheduled_task_run_logs 里 daily-feed 那一轮跑完了吗？" },
      { role: "assistant", text: "Ran: sqlite3 tasks.db 'select * from scheduled_task_run_logs'\nOutput: permission denied，daily-feed 运行状态无法继续查询。" },
      { role: "user", text: "recallkit 的记忆存储在哪，索引怎么建？" },
      { role: "assistant", text: "Read: ~/.local/share/recallkit/\n没有权限读取该目录，recallkit 存储与索引方式无法继续核实。" },
    ],
  },
];

// Filler sessions: generic engineering chatter. They share common words with
// the seeds (决定/清单/修复/项目) so IDF is realistic, but never carry a seed's
// unique identifier terms.
const FILLER_TOPICS = [
  "修复清单 逐项处理 验证", "项目 进度 收尾 行号证据", "配置 同步 目录 收敛",
  "数据 重构 json 体量", "样式 内容 更新 页面", "定时任务 采集 部署 入口",
  "账号 模型 网关 核对", "终端 产品形态 讨论", "索引 分词 中文 检索",
  "缓存 权限 隔离 冒烟", "评审 范围 确认 报告", "冲突 合并 产物 落盘",
];
const FILLER_PROJECTS = ["/work/acme", "/work/notes", "/work/pages", "/work/sandbox"];

function fillerSessions(): SessionSpec[] {
  const out: SessionSpec[] = [];
  for (let i = 0; i < 40; i += 1) {
    const topic = FILLER_TOPICS[i % FILLER_TOPICS.length]!;
    const project = FILLER_PROJECTS[i % FILLER_PROJECTS.length]!;
    const agent = (["claude", "codex", "opencode"] as const)[i % 3]!;
    out.push({
      sid: sid(100 + i),
      agent,
      project,
      title: `${topic} 讨论 ${i}`,
      messages: [
        { role: "user", text: `第 ${i} 轮：${topic}，请按清单逐项修复并给出行号证据。` },
        { role: "assistant", text: `决定：${topic} 已处理，范围收束，不继续扩大。` },
        { role: "user", text: `补充：${topic} 的边界条件再核对一遍。` },
        { role: "assistant", text: `已核对 ${topic} 的边界，结论不变。` },
      ],
    });
  }
  return out;
}

function writeClaudeSession(spec: SessionSpec, root: string, index: number): void {
  const projectDir = join(root, spec.project.replaceAll("/", "-"));
  mkdirSync(projectDir, { recursive: true });
  const lines = spec.messages.map((m, i) =>
    JSON.stringify({
      type: m.role,
      timestamp: ts(index * 10 + i),
      cwd: spec.project,
      isSidechain: false,
      message: { role: m.role, content: [{ type: "text", text: m.text }] },
    }),
  );
  writeFileSync(join(projectDir, `${spec.sid}.jsonl`), lines.join("\n") + "\n");
}

function writeCodexSession(spec: SessionSpec, root: string, index: number): void {
  const dir = join(root, "2026/01/10");
  mkdirSync(dir, { recursive: true });
  const lines: string[] = [
    JSON.stringify({
      timestamp: ts(index * 10),
      type: "session_meta",
      payload: { id: spec.sid, cwd: spec.project, timestamp: ts(index * 10) },
    }),
  ];
  spec.messages.forEach((m, i) => {
    lines.push(
      JSON.stringify({
        timestamp: ts(index * 10 + i),
        type: "event_msg",
        payload: {
          type: "item_completed",
          item: {
            type: m.role === "user" ? "UserMessage" : "AgentMessage",
            content: [{ type: "text", text: m.text }],
          },
        },
      }),
    );
  });
  writeFileSync(join(dir, `rollout-${spec.sid}.jsonl`), lines.join("\n") + "\n");
}

function writeOpencodeSession(db: Database.Database, spec: SessionSpec, index: number): void {
  const created = BASE_MS + index * 10 * 60_000;
  db.prepare(
    "INSERT INTO session_v2(id, title, directory, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
  ).run(spec.sid, spec.title, spec.project, created, created + spec.messages.length * 60_000);
  const insert = db.prepare(
    "INSERT INTO session_message(id, session_id, type, seq, time_created, data) VALUES (?, ?, ?, ?, ?, ?)",
  );
  spec.messages.forEach((m, i) => {
    const data =
      m.role === "user"
        ? JSON.stringify({ text: m.text })
        : JSON.stringify({ content: [{ type: "text", text: m.text }] });
    insert.run(`${spec.sid}-${i}`, spec.sid, m.role, i, created + i * 60_000, data);
  });
}

function buildCorpusDb(sessions: SessionSpec[]): void {
  mkdirSync(TMP_DIR, { recursive: true });
  const path = join(TMP_DIR, "corpus.db");
  rmSync(path, { force: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE sessions (
      sid TEXT PRIMARY KEY, agent TEXT NOT NULL, project TEXT NOT NULL,
      cwd TEXT, title TEXT, started TEXT, updated TEXT, source_path TEXT NOT NULL
    );
    CREATE TABLE postings (term TEXT NOT NULL, sid TEXT NOT NULL, PRIMARY KEY (term, sid)) WITHOUT ROWID;
    CREATE INDEX postings_sid ON postings(sid);
    CREATE TABLE prompts (
      id INTEGER PRIMARY KEY, sid TEXT NOT NULL, agent TEXT NOT NULL, ordinal INTEGER NOT NULL,
      timestamp TEXT, first_line TEXT NOT NULL, full_text TEXT NOT NULL, terms INTEGER NOT NULL
    );
    CREATE INDEX prompts_sid ON prompts(sid);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  db.prepare("INSERT INTO meta(key, value) VALUES('cutoff', ?)").run(CUTOFF);
  const insertSession = db.prepare(
    "INSERT INTO sessions(sid, agent, project, cwd, title, started, updated, source_path) VALUES (?, ?, ?, ?, ?, ?, ?, '')",
  );
  const insertTerm = db.prepare("INSERT OR IGNORE INTO postings(term, sid) VALUES (?, ?)");
  const insertPrompt = db.prepare(
    "INSERT INTO prompts(sid, agent, ordinal, timestamp, first_line, full_text, terms) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  sessions.forEach((spec, index) => {
    const terms = new Set<string>();
    for (const m of spec.messages) for (const t of tokenize(m.text)) terms.add(t);
    const started = ts(index * 10);
    const updated = ts(index * 10 + spec.messages.length);
    insertSession.run(spec.sid, spec.agent, spec.project, spec.project, spec.title, started, updated);
    for (const t of terms) insertTerm.run(t, spec.sid);
    spec.messages.forEach((m, i) => {
      if (m.role !== "user") return;
      insertPrompt.run(spec.sid, spec.agent, i, ts(index * 10 + i), m.text, m.text, tokenize(m.text).length);
    });
  });
  db.close();
}

function main(): void {
  const sessions = [...SEED_SESSIONS, ...NEGATIVE_ANCHORS, ...fillerSessions()];
  const roots = {
    claude: join(TMP_DIR, "synthetic/claude"),
    codex: join(TMP_DIR, "synthetic/codex"),
    opencode: join(TMP_DIR, "synthetic/opencode.db"),
  };
  rmSync(join(TMP_DIR, "synthetic"), { recursive: true, force: true });
  mkdirSync(roots.claude, { recursive: true });
  mkdirSync(roots.codex, { recursive: true });
  const oc = new Database(roots.opencode);
  oc.exec(`
    CREATE TABLE session_v2 (id TEXT PRIMARY KEY, title TEXT, directory TEXT NOT NULL, time_created INTEGER NOT NULL, time_updated INTEGER NOT NULL);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, type TEXT NOT NULL, seq INTEGER NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `);
  sessions.forEach((spec, index) => {
    if (spec.agent === "claude") writeClaudeSession(spec, roots.claude, index);
    else if (spec.agent === "codex") writeCodexSession(spec, roots.codex, index);
    else writeOpencodeSession(oc, spec, index);
  });
  oc.close();
  buildCorpusDb(sessions);
  writeFileSync(
    join(BENCH_DIR, "synthetic-roots.json"),
    JSON.stringify({ cutoff: CUTOFF, roots: { claude: ".bench-tmp/synthetic/claude", codex: ".bench-tmp/synthetic/codex", opencode: ".bench-tmp/synthetic/opencode.db" }, sessions: sessions.length }, null, 2) + "\n",
  );
  console.log(JSON.stringify({ sessions: sessions.length, roots }, null, 2));
}

main();