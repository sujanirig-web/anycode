/*
┌──────────────────────────────────────────────────────────────┐
│ test/coding-box.test.ts — live coding activity box           │
└──────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FileChange } from "../src/tools/types.js";
import type { ToolCall } from "../src/types.js";
import { ActivityTracker } from "../src/ui/activity.js";
import { renderCardPanel } from "../src/ui/card.js";
import { stripAnsi } from "../src/util/ansi.js";

function call(name: string, input: Record<string, unknown>): ToolCall {
  return { id: `${name}-1`, name, arguments: JSON.stringify(input) };
}

const update: FileChange = {
  kind: "update",
  path: "src/auth.ts",
  diff: "@@ -1,2 +1,2 @@\n-const fixed = false;\n+const fixed = true;",
  added: 1,
  removed: 1,
};

function render(tracker: ActivityTracker, expanded = false): string {
  const card = tracker.currentCard ?? tracker.lastCard;
  assert.ok(card, "a card should exist");
  return renderCardPanel(card, 76, undefined, 0, expanded)
    .map(stripAnsi)
    .join("\n");
}

describe("live coding box", () => {
  it("attaches file changes to the card for the current request", () => {
    const tracker = new ActivityTracker();
    const card = tracker.startCard("Fix the login bug");
    tracker.addStep(call("read", { path: "src/auth.ts" }), { path: "src/auth.ts" });
    const changed = tracker.addChange(update);

    assert.equal(changed.id, card.id, "changes stay in the active box");
    assert.ok(card.changes);
    assert.equal(card.changes.length, 1);
    assert.equal(card.changes[0]!.path, "src/auth.ts");
  });

  it("shows the request, running steps and changed files in realtime", () => {
    const tracker = new ActivityTracker();
    tracker.startCard("Fix the login bug");
    tracker.addStep(call("read", { path: "src/auth.ts" }), { path: "src/auth.ts" });
    tracker.addChange(update);

    const text = render(tracker);
    assert.match(text, /Fix the login bug/);
    assert.match(text, /1 step/);
    assert.match(text, /1 file/);
    assert.match(text, /read/);
    assert.match(text, /src\/auth\.ts/);
    assert.match(text, /update src\/auth\.ts \(\+1 -1\)/);
    assert.match(text, /\+const fixed = true;/);
  });

  it("keeps a compact file summary after the box collapses", () => {
    const tracker = new ActivityTracker();
    tracker.startCard("Fix the login bug");
    tracker.addStep(call("edit", { path: "src/auth.ts" }), { path: "src/auth.ts" });
    tracker.addChange(update);
    tracker.completeStep("step-1", "updated src/auth.ts", false, 12);
    tracker.finishCurrentCard();

    const collapsed = render(tracker);
    assert.match(collapsed, /update src\/auth\.ts/);
    assert.doesNotMatch(collapsed, /\+const fixed = true;/);

    const expanded = render(tracker, true);
    assert.match(expanded, /\+const fixed = true;/);
  });

  it("bounds long diffs and offers expansion instead of flooding the box", () => {
    const tracker = new ActivityTracker();
    tracker.startCard("Generate the data file");
    tracker.addStep(call("write", { path: "big.txt" }), { path: "big.txt" });
    const lines = Array.from({ length: 40 }, (_, index) => `+line ${index + 1}`);
    tracker.addChange({
      kind: "create",
      path: "big.txt",
      diff: `@@ -0,0 +1,40 @@\n${lines.join("\n")}`,
      added: 40,
      removed: 0,
    });

    const text = render(tracker);
    assert.match(text, /more lines/);
    assert.doesNotMatch(text, /\+line 40$/m);
  });
});
