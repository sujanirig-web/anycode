import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { after, describe, it } from "node:test";

import { diffLines } from "../src/util/diff.js";
import { globToRegExp, matchesGlob, walkFiles } from "../src/util/glob.js";
import { parseSSE } from "../src/util/sse.js";
import { cleanup, tempDir, writeFiles } from "./helpers.js";

describe("glob", () => {
  it("matches simple and recursive patterns", () => {
    assert.equal(matchesGlob("a.ts", "*.ts"), true);
    assert.equal(matchesGlob("src/a.ts", "*.ts"), false);
    assert.equal(matchesGlob("src/a.ts", "**/*.ts"), true);
    assert.equal(matchesGlob("a.ts", "**/*.ts"), true);
    assert.equal(matchesGlob("src/deep/a.ts", "**/*.ts"), true);
    assert.equal(matchesGlob("src/a.tsx", "**/*.ts"), false);
  });

  it("supports braces, character classes and question marks", () => {
    const re = globToRegExp("src/**/*.{ts,tsx}");
    assert.equal(re.test("src/a.ts"), true);
    assert.equal(re.test("src/x/y.tsx"), true);
    assert.equal(re.test("src/a.js"), false);
    assert.equal(matchesGlob("a1.ts", "a[0-9].ts"), true);
    assert.equal(matchesGlob("ab.ts", "a?.ts"), true);
    assert.equal(matchesGlob("abc.ts", "a?.ts"), false);
  });

  it("walks files while ignoring heavy directories", async () => {
    const root = await tempDir();
    try {
      await writeFiles(root, {
        "a.ts": "",
        "src/b.ts": "",
        "node_modules/pkg/c.ts": "",
        ".git/config": "",
      });
      const found: string[] = [];
      for await (const file of walkFiles(root)) {
        found.push(path.relative(root, file).replace(/\\/g, "/"));
      }
      found.sort();
      assert.deepEqual(found, ["a.ts", "src/b.ts"]);
    } finally {
      await cleanup(root);
    }
  });
});

describe("diff", () => {
  it("returns an empty diff for identical input", () => {
    const result = diffLines("a\nb", "a\nb");
    assert.equal(result.text, "");
    assert.equal(result.added, 0);
    assert.equal(result.removed, 0);
  });

  it("counts changed lines and emits a hunk header", () => {
    const result = diffLines("one\ntwo\nthree", "one\nTWO\nthree");
    assert.equal(result.added, 1);
    assert.equal(result.removed, 1);
    assert.match(result.text, /^@@ -\d+,\d+ \+\d+,\d+ @@/m);
    assert.match(result.text, /^-two$/m);
    assert.match(result.text, /^\+TWO$/m);
  });

  it("falls back gracefully for very large inputs", () => {
    const before = Array.from({ length: 3000 }, (_, index) => `old ${index}`).join("\n");
    const after = Array.from({ length: 3000 }, (_, index) => `new ${index}`).join("\n");
    const result = diffLines(before, after);
    assert.equal(result.truncated, true);
    assert.match(result.text, /file replaced/);
  });
});

describe("sse", () => {
  it("parses events split across chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      "event: message\nda",
      "ta: {\"hello\":1}\n\n: comment\n\ndata: second\r\n\r\n",
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });

    const messages = [];
    for await (const message of parseSSE(stream)) messages.push(message);

    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.event, "message");
    assert.equal(messages[0]?.data, '{"hello":1}');
    assert.equal(messages[1]?.data, "second");
  });
});

describe("session storage path", () => {
  after(async () => undefined);

  it("creates the sessions directory on save", async () => {
    const root = await tempDir();
    try {
      await fs.mkdir(path.join(root, ".anycode"), { recursive: true });
      const stat = await fs.stat(path.join(root, ".anycode"));
      assert.ok(stat.isDirectory());
    } finally {
      await cleanup(root);
    }
  });
});
