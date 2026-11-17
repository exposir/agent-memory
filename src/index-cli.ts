import { indexAll } from "./index.js";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const dbPath = argument("--db");
const quiet = process.argv.includes("--quiet");

const stats = await indexAll({
  ...(dbPath ? { dbPath } : {}),
  quiet,
  roots: {
    ...(process.env.MEM_CLAUDE_ROOT ? { claude: process.env.MEM_CLAUDE_ROOT } : {}),
    ...(process.env.MEM_CODEX_ROOT ? { codex: process.env.MEM_CODEX_ROOT } : {}),
    ...(process.env.MEM_OPENCODE_DB ? { opencode: process.env.MEM_OPENCODE_DB } : {}),
    ...(process.env.MEM_QODER_ROOT ? { qoder: process.env.MEM_QODER_ROOT } : {}),
    ...(process.env.MEM_PI_ROOT ? { pi: process.env.MEM_PI_ROOT } : {}),
    ...(process.env.MEM_DSH_ROOT ? { dsh: process.env.MEM_DSH_ROOT } : {}),
    ...(process.env.MEM_ANTIGRAVITY_ROOT
      ? { antigravity: process.env.MEM_ANTIGRAVITY_ROOT }
      : {}),
  },
});

process.stdout.write(`${JSON.stringify(stats, null, 2)}\n`);
if (stats.errors.length > 0) {
  process.exitCode = 1;
}
