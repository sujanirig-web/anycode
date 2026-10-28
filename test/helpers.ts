/*
┌──────────────────────────────────────────────────────────────────┐
│ test/helpers.ts — temp dir, cleanup, writeFiles test utilities     │
└──────────────────────────────────────────────────────────────────┘
*/
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export async function tempDir(prefix = "anycode-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

export async function writeFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");
  }
}
