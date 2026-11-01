#!/usr/bin/env node
/**
 * Compile into a staging directory, then move each emitted file over the live
 * `dist/` file with an atomic rename. A failed or interrupted compile never
 * leaves a half-written module behind for a running `anycode`, and a running
 * process always sees either the old or the new complete file.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const root = process.cwd();
const dist = join(root, "dist");
const staging = join(root, `.dist-build-${process.pid}`);
const tsc = join(root, "node_modules", "typescript", "bin", "tsc");

function remove(path) {
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      yield* walk(path);
    } else {
      yield path;
    }
  }
}

if (!existsSync(tsc)) {
  console.error("build: TypeScript is not installed. Run `npm install` first.");
  process.exit(1);
}

remove(staging);

const result = spawnSync(
  process.execPath,
  [tsc, "-p", join(root, "tsconfig.json"), "--outDir", staging],
  { stdio: "inherit" },
);

if (result.error) {
  remove(staging);
  console.error(`build: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  remove(staging);
  process.exit(result.status ?? 1);
}

try {
  for (const file of walk(staging)) {
    const target = join(dist, relative(staging, file));
    mkdirSync(dirname(target), { recursive: true });
    renameSync(file, target);
  }
  // tsc emits 0644 files; the package bin is launched through a symlink, so
  // keep the executable bit that npm sets up when linking the package.
  const cli = join(dist, "cli.js");
  if (existsSync(cli)) chmodSync(cli, 0o755);
} catch (error) {
  remove(staging);
  console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

remove(staging);
