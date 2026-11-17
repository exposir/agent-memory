import { join, resolve } from "node:path";

export const REPO_ROOT = resolve(import.meta.dirname, "../..");
export const BENCH_DIR = join(REPO_ROOT, "bench");
export const TMP_DIR = join(REPO_ROOT, ".bench-tmp");

export const DEFAULT_CORPUS_CUTOFF = "2026-01-15T00:00:00.000Z";
