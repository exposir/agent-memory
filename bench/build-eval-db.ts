import { readFileSync } from "node:fs";
import { join } from "node:path";

import { indexAll } from "../src/index.js";
import { REPO_ROOT, TMP_DIR } from "./lib/paths.js";

// Build the searchable mem.db from the synthetic transcript roots written by
// build-synthetic.ts. Every non-synthetic source is pointed at an empty path
// so a real home directory is never touched.
interface RootsDoc {
  cutoff: string;
  roots: { claude: string; codex: string; opencode: string };
}

async function main(): Promise<void> {
  const doc = JSON.parse(
    readFileSync(join(REPO_ROOT, "bench/synthetic-roots.json"), "utf8"),
  ) as RootsDoc;
  const stats = await indexAll({
    dbPath: join(TMP_DIR, "mem.db"),
    quiet: true,
    now: new Date(doc.cutoff),
    roots: {
      claude: join(REPO_ROOT, doc.roots.claude),
      codex: join(REPO_ROOT, doc.roots.codex),
      opencode: join(REPO_ROOT, doc.roots.opencode),
      qoder: join(TMP_DIR, "empty-qoder"),
      pi: join(TMP_DIR, "empty-pi"),
      dsh: join(TMP_DIR, "empty-dsh"),
      antigravity: join(TMP_DIR, "empty-antigravity"),
    },
  });
  console.log(JSON.stringify(stats, null, 2));
}

void main();