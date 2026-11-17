#!/usr/bin/env node

import { existsSync, readdirSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = new URL("../dist/cli.js", import.meta.url);
const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function newestSourceMtime(path) {
  let newest = 0;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = `${path}/${entry.name}`;
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestSourceMtime(child));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      newest = Math.max(newest, statSync(child).mtimeMs);
    }
  }
  return newest;
}

const needsBuild =
  !existsSync(dist) ||
  (existsSync(sourceRoot) &&
    newestSourceMtime(sourceRoot) > statSync(fileURLToPath(dist)).mtimeMs);

if (needsBuild) {
  const tsc = fileURLToPath(
    new URL("../node_modules/typescript/bin/tsc", import.meta.url),
  );
  if (existsSync(tsc)) {
    const built = spawnSync(
      process.execPath,
      [tsc, "-p", fileURLToPath(new URL("../tsconfig.build.json", import.meta.url))],
      {
        cwd: root,
        stdio: ["ignore", "ignore", "inherit"],
        timeout: 30_000,
      },
    );
    if (built.status !== 0) {
      process.stderr.write("mem: TypeScript build failed\n");
      process.exit(2);
    }
  }
}

if (existsSync(dist)) {
  await import(dist.href);
} else {
  const { register } = await import("tsx/esm/api");
  register();
  await import(new URL("../src/cli.ts", import.meta.url).href);
}
