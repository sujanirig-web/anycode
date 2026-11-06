/*
┌──────────────────────────────────────────────────────────────┐
│ test/changes.test.ts — live file-change diffs                │
└──────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { Session } from "../src/agent/session.js";
import { MockProvider, textTurn, toolTurn, type MockScript } from "../src/llm/mock.js";
import { copyTool } from "../src/tools/copy.js";
import { deleteTool } from "../src/tools/delete.js";
import { editTool } from "../src/tools/edit.js";
import { mkdirTool } from "../src/tools/mkdir.js";
import { moveTool } from "../src/tools/move.js";
import type { FileChange, ToolContext } from "../src/tools/types.js";
import { writeTool } from "../src/tools/write.js";
import { renderStatusStrip } from "../src/ui/screen.js";
import { describeFileChangeColored } from "../src/ui/renderer.js";
import { stripAnsi } from "../src/util/ansi.js";
import { Transcript } from "../src/ui/transcript.js";
import { cleanup, tempDir, writeFiles } from "./helpers.js";

function context(cwd: string, changes: FileChange[], approved = true): ToolContext {
  return {
    cwd,
    approve: async () => approved,
    onFileChange: (change) => changes.push(change),
  };
}

describe("tool file changes", () => {
  it("reports a created file with an added-lines diff", async () => {
    const root = await tempDir();
    try {
      const changes: FileChange[] = [];
      await writeTool.execute(
        { path: "src/new.ts", content: "export const a = 1;\nexport const b = 2;\n" },
        context(root, changes),
      );

      assert.equal(changes.length, 1);
      const change = changes[0]!;
      assert.equal(change.kind, "create");
      assert.equal(change.path, path.join("src", "new.ts"));
      assert.equal(change.added, 2);
      assert.equal(change.removed, 0);
      assert.match(change.diff ?? "", /^@@ /);
      assert.match(change.diff ?? "", /^\+export const a = 1;$/m);
      assert.match(change.diff ?? "", /^\+export const b = 2;$/m);
    } finally {
      await cleanup(root);
    }
  });

  it("reports an updated file with the real diff", async () => {
    const root = await tempDir();
    try {
      await writeFiles(root, { "note.txt": "alpha\nbeta\ngamma\n" });
      const changes: FileChange[] = [];
      await writeTool.execute(
        { path: "note.txt", content: "alpha\nBETA\ngamma\n" },
        context(root, changes),
      );

      assert.equal(changes.length, 1);
      const change = changes[0]!;
      assert.equal(change.kind, "update");
      assert.equal(change.path, "note.txt");
      assert.equal(change.added, 1);
      assert.equal(change.removed, 1);
      assert.match(change.diff ?? "", /^-beta$/m);
      assert.match(change.diff ?? "", /^\+BETA$/m);
    } finally {
      await cleanup(root);
    }
  });

  it("reports an edit as an update", async () => {
    const root = await tempDir();
    try {
      await writeFiles(root, { "a.ts": "const value = 1;\n" });
      const changes: FileChange[] = [];
      await editTool.execute(
        { path: "a.ts", old_string: "1", new_string: "42" },
        context(root, changes),
      );

      assert.equal(changes.length, 1);
      assert.equal(changes[0]!.kind, "update");
      assert.equal(changes[0]!.added, 1);
      assert.equal(changes[0]!.removed, 1);
      assert.match(changes[0]!.diff ?? "", /\+const value = 42;/);
    } finally {
      await cleanup(root);
    }
  });

  it("reports non-text filesystem changes", async () => {
    const root = await tempDir();
    try {
      await writeFiles(root, { "from.txt": "hello\n" });
      const changes: FileChange[] = [];

      await mkdirTool.execute({ path: "made" }, context(root, changes));
      await copyTool.execute(
        { source: "from.txt", destination: "copied.txt" },
        context(root, changes),
      );
      await moveTool.execute(
        { source: "copied.txt", destination: "moved.txt" },
        context(root, changes),
      );
      await deleteTool.execute({ path: "moved.txt" }, context(root, changes));

      assert.deepEqual(
        changes.map((change) => change.kind),
        ["mkdir", "copy", "move", "delete"],
      );
      assert.equal(changes[0]!.path, "made");
      assert.equal(changes[1]!.from, "from.txt");
      assert.equal(changes[1]!.to, "copied.txt");
      assert.equal(changes[2]!.from, "copied.txt");
      assert.equal(changes[2]!.to, "moved.txt");
      assert.equal(changes[3]!.path, "moved.txt");
    } finally {
      await cleanup(root);
    }
  });

  it("does not report a change when permission is denied", async () => {
    const root = await tempDir();
    try {
      const changes: FileChange[] = [];
      await assert.rejects(
        writeTool.execute({ path: "denied.txt", content: "no" }, context(root, changes, false)),
        /denied permission/,
      );
      assert.deepEqual(changes, []);
      await assert.rejects(fs.stat(path.join(root, "denied.txt")));
    } finally {
      await cleanup(root);
    }
  });
});

describe("agent file-change events", () => {
  it("emits file changes after the tool result", async () => {
    const root = await tempDir();
    try {
      const script: MockScript = (_request, turn) => {
        if (turn === 0) {
          return toolTurn({
            name: "write",
            arguments: JSON.stringify({ path: "hello.txt", content: "hi there\n" }),
          });
        }
        return textTurn("Done.");
      };

      const session = Session.create({ cwd: root, provider: "mock", model: "mock-1" });
      const agent = new Agent({
        provider: new MockProvider(script),
        model: "mock-1",
        cwd: root,
        session,
        system: "test",
        approve: async () => true,
      });

      const events: AgentEvent[] = [];
      for await (const event of agent.run("write it")) events.push(event);

      const toolEnd = events.findIndex((event) => event.type === "tool_end");
      const changeEvent = events.find(
        (event): event is Extract<AgentEvent, { type: "file_change" }> =>
          event.type === "file_change",
      );
      assert.ok(toolEnd >= 0);
      assert.ok(changeEvent);
      assert.ok(events.indexOf(changeEvent) > toolEnd, "change should follow tool_end");
      assert.equal(changeEvent.change.kind, "create");
      assert.equal(changeEvent.change.path, "hello.txt");
      assert.match(changeEvent.change.diff ?? "", /\+hi there/);
    } finally {
      await cleanup(root);
    }
  });
});

describe("transcript file-change blocks", () => {
  it("renders a diff with colored add/remove lines", () => {
    const transcript = new Transcript();
    transcript.pushFileChange({
      kind: "update",
      path: "src/a.ts",
      diff: "@@ -1,2 +1,2 @@\n-const old = 1;\n+const next = 2;\n unchanged",
      added: 1,
      removed: 1,
    });

    const rendered = transcript.render(80, false);
    const text = rendered.map(stripAnsi).join("\n");
    assert.match(text, /update src\/a\.ts \(\+1 -1\)/);
    assert.match(text, /-const old = 1;/);
    assert.match(text, /\+const next = 2;/);

    const raw = rendered.join("\n");
    assert.ok(raw.includes("\u001b["), "diff lines should be colored");
  });

  it("collapses long diffs until expanded", () => {
    const transcript = new Transcript();
    const lines = Array.from({ length: 60 }, (_, index) => `+line ${index + 1}`);
    transcript.pushFileChange({
      kind: "create",
      path: "big.txt",
      diff: `@@ -0,0 +1,60 @@\n${lines.join("\n")}`,
      added: 60,
      removed: 0,
    });

    const collapsed = transcript.render(80, false).map(stripAnsi).join("\n");
    assert.match(collapsed, /more lines/);
    assert.doesNotMatch(collapsed, /\+line 40/);

    const expanded = transcript.render(80, true).map(stripAnsi).join("\n");
    assert.match(expanded, /\+line 40/);
    assert.match(expanded, /\+line 60/);
  });

  it("summarizes non-text changes without a diff", () => {
    const transcript = new Transcript();
    transcript.pushFileChange({
      kind: "move",
      path: "b.txt",
      from: "a.txt",
      to: "b.txt",
    });

    const text = transcript.render(80, false).map(stripAnsi).join("\n");
    assert.match(text, /move a\.txt → b\.txt/);
  });
});

describe("semantic change coloring", () => {
  it("tints each change kind like a diff summary", () => {
    // Basic ANSI foreground codes from util/ansi color helpers.
    assert.ok(
      describeFileChangeColored({ kind: "create", path: "a.ts", added: 1, removed: 0 }).startsWith(
        "\u001b[32m",
      ),
      "creates render green",
    );
    assert.ok(
      describeFileChangeColored({ kind: "delete", path: "a.ts" }).startsWith("\u001b[31m"),
      "deletes render red",
    );
    assert.ok(
      describeFileChangeColored({ kind: "move", path: "b.ts", from: "a.ts", to: "b.ts" }).startsWith(
        "\u001b[33m",
      ),
      "moves render yellow",
    );
    assert.ok(
      describeFileChangeColored({ kind: "mkdir", path: "dir" }).startsWith("\u001b[36m"),
      "directories render cyan",
    );
  });

  it("paints added and removed stats green and red", () => {
    const painted = describeFileChangeColored({
      kind: "update",
      path: "a.ts",
      added: 3,
      removed: 2,
    });
    assert.match(painted, /\u001b\[32m\+3\u001b\[39m/, "additions are green");
    assert.match(painted, /\u001b\[31m-2\u001b\[39m/, "removals are red");
    assert.equal(stripAnsi(painted), "update a.ts (+3 -2)");
  });
});

describe("status strip file count", () => {
  it("shows how many files changed in the current turn", () => {
    const many = renderStatusStrip(
      { status: "working", changedFiles: 3 },
      80,
    )
      .map(stripAnsi)
      .join("\n");
    assert.match(many, /3 files changed/);

    const one = renderStatusStrip(
      { status: "working", changedFiles: 1 },
      80,
    )
      .map(stripAnsi)
      .join("\n");
    assert.match(one, /1 file changed/);
  });
});
