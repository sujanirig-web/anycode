import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { bashTool } from "../src/tools/bash.js";
import { editTool } from "../src/tools/edit.js";
import { globTool } from "../src/tools/glob.js";
import { grepTool } from "../src/tools/grep.js";
import { readTool } from "../src/tools/read.js";
import type { ToolContext } from "../src/tools/types.js";
import { writeTool } from "../src/tools/write.js";
import { cleanup, tempDir, writeFiles } from "./helpers.js";

function context(cwd: string, approved = true): ToolContext {
  return {
    cwd,
    approve: async () => approved,
  };
}

describe("file tools", () => {
  it("writes, reads and edits a file", async () => {
    const root = await tempDir();
    try {
      const write = await writeTool.execute(
        { path: "src/hello.txt", content: "alpha\nbeta\n" },
        context(root),
      );
      assert.match(write, /Wrote src\/hello\.txt/);

      const read = await readTool.execute({ path: "src/hello.txt" }, context(root));
      assert.match(read, /lines 1-2 of 2/);
      assert.match(read, /1\| alpha/);
      assert.match(read, /2\| beta/);

      const edit = await editTool.execute(
        { path: "src/hello.txt", old_string: "beta", new_string: "gamma" },
        context(root),
      );
      assert.match(edit, /\+1 -1/);

      const after = await fs.readFile(path.join(root, "src/hello.txt"), "utf8");
      assert.equal(after, "alpha\ngamma\n");
    } finally {
      await cleanup(root);
    }
  });

  it("rejects ambiguous and missing edits with recovery hints", async () => {
    const root = await tempDir();
    try {
      await writeFiles(root, { "a.txt": "x\nx\n" });

      await assert.rejects(
        editTool.execute({ path: "a.txt", old_string: "x", new_string: "y" }, context(root)),
        /appears 2 times/,
      );

      await assert.rejects(
        editTool.execute({ path: "a.txt", old_string: "zzz", new_string: "y" }, context(root)),
        /was not found/,
      );

      const all = await editTool.execute(
        { path: "a.txt", old_string: "x", new_string: "y", replace_all: true },
        context(root),
      );
      assert.match(all, /2 replacements/);
      assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "y\ny\n");
    } finally {
      await cleanup(root);
    }
  });

  it("honours denied permissions", async () => {
    const root = await tempDir();
    try {
      await assert.rejects(
        writeTool.execute({ path: "denied.txt", content: "no" }, context(root, false)),
        /denied permission/,
      );
      await assert.rejects(fs.stat(path.join(root, "denied.txt")));
    } finally {
      await cleanup(root);
    }
  });

  it("refuses to read binary files", async () => {
    const root = await tempDir();
    try {
      await fs.writeFile(path.join(root, "bin"), Buffer.from([0, 1, 2, 3]));
      await assert.rejects(readTool.execute({ path: "bin" }, context(root)), /binary/);
    } finally {
      await cleanup(root);
    }
  });

  it("pages large files with offset and limit", async () => {
    const root = await tempDir();
    try {
      const lines = Array.from({ length: 100 }, (_, index) => `line-${index + 1}`).join("\n");
      await fs.writeFile(path.join(root, "big.txt"), lines);
      const page = await readTool.execute(
        { path: "big.txt", offset: 20, limit: 3 },
        context(root),
      );
      assert.match(page, /lines 20-22 of 100/);
      assert.match(page, /20\| line-20/);
      assert.doesNotMatch(page, /line-23/);
    } finally {
      await cleanup(root);
    }
  });
});

describe("search tools", () => {
  it("finds files by glob, newest first", async () => {
    const root = await tempDir();
    try {
      await writeFiles(root, { "a.ts": "", "src/b.ts": "", "src/c.js": "" });
      const result = await globTool.execute({ pattern: "**/*.ts" }, context(root));
      assert.match(result, /2 files matched/);
      assert.match(result, /a\.ts/);
      assert.match(result, /src\/b\.ts/);
      assert.doesNotMatch(result, /c\.js/);
    } finally {
      await cleanup(root);
    }
  });

  it("greps with include filters and literal mode", async () => {
    const root = await tempDir();
    try {
      await writeFiles(root, {
        "src/a.ts": "const needle = 1;\nconst other = 2;\n",
        "src/b.js": "needle but in js\n",
        "src/c.ts": "function x() { return 'a.b'; }\n",
      });

      const filtered = await grepTool.execute(
        { pattern: "needle", include: "*.ts" },
        context(root),
      );
      assert.match(filtered, /src\/a\.ts:1/);
      assert.doesNotMatch(filtered, /b\.js/);

      const literal = await grepTool.execute(
        { pattern: "a.b", fixed_strings: true, path: "src/c.ts" },
        context(root),
      );
      assert.match(literal, /1 match/);
    } finally {
      await cleanup(root);
    }
  });
});

describe("bash tool", () => {
  it("runs commands and reports exit codes", async () => {
    const root = await tempDir();
    try {
      const result = await bashTool.execute(
        { command: 'node -e "console.log(\'ok\')"' },
        context(root),
      );
      assert.match(result, /status: exit code 0/);
      assert.match(result, /ok/);
    } finally {
      await cleanup(root);
    }
  });

  it("reports non-zero exits as information", async () => {
    const root = await tempDir();
    try {
      const result = await bashTool.execute(
        { command: 'node -e "process.exit(3)"' },
        context(root),
      );
      assert.match(result, /status: exit code 3/);
    } finally {
      await cleanup(root);
    }
  });

  it("denies commands without approval", async () => {
    const root = await tempDir();
    try {
      await assert.rejects(
        bashTool.execute({ command: "echo nope" }, context(root, false)),
        /denied permission/,
      );
    } finally {
      await cleanup(root);
    }
  });

  it("kills commands that exceed the timeout", async () => {
    const root = await tempDir();
    try {
      const result = await bashTool.execute(
        { command: 'node -e "setTimeout(() => {}, 5000)"', timeout: 1000 },
        context(root),
      );
      assert.match(result, /timed out after 1000ms/);
    } finally {
      await cleanup(root);
    }
  });
});
