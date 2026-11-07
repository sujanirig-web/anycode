/*
┌──────────────────────────────────────────────────────────────────┐
│ test/tui.test.ts — TUI frame, palette, editor, keys, transcript   │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Session } from "../src/agent/session.js";
import { colorEnabled } from "../src/util/ansi.js";
import { Editor } from "../src/ui/editor.js";
import { KeyParser } from "../src/ui/keys.js";
import { composeFrame } from "../src/ui/screen.js";
import { Tui } from "../src/ui/tui.js";
import { Transcript } from "../src/ui/transcript.js";
import { stringWidth, stripAnsi } from "../src/util/width.js";
import { wrapText } from "../src/util/wrap.js";
import { ActivityTracker, type ActivityCard } from "../src/ui/activity.js";
import { renderCardPanel } from "../src/ui/card.js";

function plain(value: string): string {
  return stripAnsi(value);
}

describe("width", () => {
  it("counts columns and ignores ANSI", () => {
    assert.equal(stringWidth("abc"), 3);
    assert.equal(stringWidth("\u001b[31mred\u001b[39m"), 3);
    assert.equal(stringWidth("你好"), 4);
    assert.equal(stringWidth("e\u0301"), 1);
  });
});

describe("wrapText", () => {
  it("wraps prose to the requested width", () => {
    const lines = wrapText("the quick brown fox jumps over the lazy dog", 16);
    assert.ok(lines.length > 1);
    for (const line of lines) assert.ok(stringWidth(line) <= 16, line);
    assert.equal(lines.join(" ").replace(/\s+/g, " "), "the quick brown fox jumps over the lazy dog");
  });

  it("splits long words and keeps explicit newlines", () => {
    const lines = wrapText("supercalifragilisticexpialidocious\nok", 10);
    assert.ok(lines.length >= 4);
    for (const line of lines) assert.ok(stringWidth(line) <= 10);
    assert.equal(lines[lines.length - 1], "ok");
  });

  it("wraps wide characters by display width", () => {
    const lines = wrapText("你好世界你好世界", 6);
    for (const line of lines) assert.ok(stringWidth(line) <= 6, line);
    assert.equal(lines.join(""), "你好世界你好世界");
  });
});

describe("KeyParser", () => {
  const parser = new KeyParser();

  it("parses arrows, ctrl modifiers and paste", () => {
    assert.deepEqual(parser.push("\u001b[A"), [{ type: "key", name: "up" }]);
    assert.deepEqual(parser.push("\u001b[1;5C"), [{ type: "key", name: "right", ctrl: true }]);
    assert.deepEqual(parser.push("\u001b[3~"), [{ type: "key", name: "delete" }]);
    assert.deepEqual(parser.push("\u001b[200~hi\nthere\u001b[201~"), [{ type: "text", text: "hi\nthere" }]);
    assert.deepEqual(parser.push("ok"), [{ type: "text", text: "ok" }]);
    assert.deepEqual(parser.push("\r"), [{ type: "key", name: "enter" }]);
    assert.deepEqual(parser.push("\n"), [{ type: "key", name: "enter", ctrl: true }]);
    assert.deepEqual(parser.push("\u0003"), [{ type: "key", name: "c", ctrl: true }]);
    assert.deepEqual(parser.push("\u0016"), [{ type: "key", name: "v", ctrl: true }]);
  });

  it("buffers split sequences and flushes a lone escape", () => {
    const split = new KeyParser();
    assert.deepEqual(split.push("\u001b["), []);
    assert.deepEqual(split.push("A"), [{ type: "key", name: "up" }]);

    const escape = new KeyParser();
    assert.deepEqual(escape.push("\u001b"), []);
    assert.equal(escape.pendingLength, 1);
    assert.deepEqual(escape.flush(), [{ type: "key", name: "escape" }]);
  });

  it("parses SGR mouse clicks with coordinates", () => {
    const mouse = new KeyParser();
    assert.deepEqual(mouse.push("\u001b[<0;5;1M"), [
      { type: "mouse", button: 0, x: 5, y: 1, release: false },
    ]);
    assert.deepEqual(mouse.push("\u001b[<0;5;1m"), [
      { type: "mouse", button: 0, x: 5, y: 1, release: true },
    ]);
  });

  it("parses classic X10 mouse clicks and wheel events", () => {
    const mouse = new KeyParser();
    // \e[M + (button + 32, x + 32, y + 32): left press at column 5, row 1.
    assert.deepEqual(mouse.push("\u001b[M" + String.fromCharCode(32, 36, 33)), [
      { type: "mouse", button: 0, x: 4, y: 1, release: false },
    ]);
    // Wheel up must not look like a left click.
    assert.deepEqual(mouse.push("\u001b[M" + String.fromCharCode(96, 36, 33)), [
      { type: "mouse", button: 64, x: 4, y: 1, release: false },
    ]);
  });

  it("buffers a split X10 mouse sequence", () => {
    const mouse = new KeyParser();
    assert.deepEqual(mouse.push("\u001b[M" + String.fromCharCode(32, 36)), []);
    assert.deepEqual(mouse.push(String.fromCharCode(33)), [
      { type: "mouse", button: 0, x: 4, y: 1, release: false },
    ]);
  });
});

describe("Editor", () => {
  it("edits, submits and remembers history", () => {
    const editor = new Editor();
    for (const char of "hello world") editor.handle({ type: "text", text: char });

    editor.handle({ type: "key", name: "left" });
    editor.handle({ type: "key", name: "backspace" });
    assert.equal(editor.text, "hello word");

    const submitted = editor.handle({ type: "key", name: "enter" });
    assert.deepEqual(submitted, { type: "submit", text: "hello word" });
    assert.equal(editor.text, "");
    assert.deepEqual(editor.history, ["hello word"]);

    editor.handle({ type: "key", name: "up" });
    assert.equal(editor.text, "hello word");
  });

  it("inserts newlines with ctrl+enter and supports word kills", () => {
    const editor = new Editor();
    editor.setText("one two three");
    editor.handle({ type: "key", name: "w", ctrl: true });
    assert.equal(editor.text, "one two ");

    const result = editor.handle({ type: "key", name: "enter", ctrl: true });
    assert.equal(result.type, "changed");
    assert.match(editor.text, /\n$/);

    editor.handle({ type: "key", name: "escape" });
    assert.equal(editor.text, "");
  });

  it("leaves app-level keys unhandled", () => {
    const editor = new Editor();
    const result = editor.handle({ type: "key", name: "c", ctrl: true });
    assert.equal(result.type, "unhandled");
    assert.equal(editor.handle({ type: "key", name: "d", ctrl: true }).type, "unhandled");
  });
});

describe("Transcript", () => {
  function build(): Transcript {
    const transcript = new Transcript();
    transcript.pushUser("fix the bug");
    transcript.appendAssistant("Looking at `src/a.ts`.\n\n```ts\nconst a = 1;\n```\n");
    transcript.startTool({ id: "1", name: "read", arguments: "{}" }, { path: "src/a.ts" });
    transcript.endTool("read", "1  const a = 1;", false, 120);
    return transcript;
  }

  it("renders user, markdown and tool output", () => {
    const lines = build().render(60, false).map(plain).join("\n");
    assert.match(lines, /› fix the bug/);
    assert.match(lines, /src\/a\.ts/);
    assert.match(lines, /const a = 1;/);
    assert.match(lines, /⏺ read/);
    assert.match(lines, /⎿/);
    assert.doesNotMatch(lines, /```/);
  });

  it("expands tool results on demand", () => {
    const transcript = new Transcript();
    transcript.endTool("bash", "status: exit code 0\nline two\nline three", false, 900);
    const collapsed = transcript.render(60, false).map(plain).join("\n");
    const expanded = transcript.render(60, true).map(plain).join("\n");
    assert.doesNotMatch(collapsed, /line two/);
    assert.match(expanded, /line two/);
    assert.match(expanded, /0\.9s/);
  });

  it("hydrates a resumed session", () => {
    const session = Session.create({ cwd: "C:/tmp", provider: "anyroute", model: "anyroute" });
    session.messages.push({ role: "user", content: "earlier question" });
    session.messages.push({ role: "assistant", content: "earlier answer" });
    session.messages.push({
      role: "tool",
      toolCallId: "1",
      name: "bash",
      content: "status: exit code 0",
    });

    const transcript = new Transcript();
    transcript.hydrate(session);
    const text = transcript.render(60, false).map(plain).join("\n");
    assert.match(text, /earlier question/);
    assert.match(text, /earlier answer/);
    assert.match(text, /bash/);
  });
});

describe("activity cards", () => {
  function card(overrides: Partial<ActivityCard> = {}): ActivityCard {
    return {
      id: "card-1",
      intent: "Editing files",
      status: "ok",
      changes: [],
      expanded: true,
      steps: [
        { id: "s1", tool: "read", status: "ok", summary: "src/a.ts", durationMs: 20 },
        { id: "s2", tool: "edit", status: "ok", summary: "src/a.ts", durationMs: 40 },
      ],
      ...overrides,
    };
  }

  it("keeps each tool burst in its own card", () => {
    const tracker = new ActivityTracker();
    tracker.addStep({ id: "call-1", name: "read", arguments: "{}" }, { path: "a.ts" });
    tracker.completeStepByCall("call-1", "one line", false, 12);
    const first = tracker.finishCurrentCard();

    tracker.addStep({ id: "call-2", name: "bash", arguments: "{}" }, { command: "npm test" });
    tracker.completeStepByCall("call-2", "status: exit code 0", false, 34);
    const second = tracker.finishCurrentCard();

    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first.id, second.id);
    assert.equal(first.steps.length, 1);
    assert.equal(second.steps.length, 1);
    assert.equal(first.steps[0]?.status, "ok");
    assert.equal(second.steps[0]?.status, "ok");
    assert.equal(first.expanded, false);
    assert.equal(second.expanded, false);
    assert.equal(tracker.currentCard, undefined);
  });

  it("completes the step that matches the provider tool call", () => {
    const tracker = new ActivityTracker();
    tracker.addStep({ id: "first-call", name: "read", arguments: "{}" }, { path: "a.ts" });
    tracker.addStep({ id: "second-call", name: "bash", arguments: "{}" }, { command: "false" });
    tracker.completeStepByCall("first-call", "one line", false, 10);
    tracker.completeStepByCall("second-call", "status: exit code 1", true, 20);

    const finished = tracker.finishCurrentCard();
    assert.ok(finished);
    assert.equal(finished.steps[0]?.status, "ok");
    assert.equal(finished.steps[1]?.status, "error");
    assert.equal(finished.status, "error");
  });

  it("keeps cards expanded in verbose mode", () => {
    const tracker = new ActivityTracker();
    tracker.toggleVerbose();
    tracker.addStep({ id: "call-1", name: "read", arguments: "{}" }, { path: "a.ts" });
    tracker.completeStepByCall("call-1", "one line", false, 12);
    const finished = tracker.finishCurrentCard();
    assert.equal(finished?.expanded, true);
  });

  it("appends a new activity block instead of replacing the previous one", () => {
    const transcript = new Transcript();
    transcript.updateCurrentActivity(card({ id: "first", intent: "First burst" }));
    transcript.updateCurrentActivity(card({ id: "second", intent: "Second burst" }));

    const text = transcript.render(72, false).map(plain).join("\n");
    assert.match(text, /First burst/);
    assert.match(text, /Second burst/);
  });

  it("renders a collapsed card as a compact summary", () => {
    const lines = renderCardPanel(card({ expanded: false }), 48).map(plain);
    assert.equal(lines.length, 2);
    assert.match(lines[0] ?? "", /▸ Editing files · 2 steps/);
    for (const line of lines) assert.equal(stringWidth(line), 48);
  });

  it("keeps every expanded card line the same width", () => {
    const lines = renderCardPanel(
      card({
        status: "error",
        steps: [
          { id: "s1", tool: "read", status: "ok", summary: "src/a.ts", durationMs: 20 },
          {
            id: "s2",
            tool: "bash",
            status: "error",
            summary: "npm test",
            detail: "status: exit code 1\nfirst failure",
            durationMs: 1200,
          },
        ],
        permission: {
          tool: "bash",
          explanation: "Run the test suite.",
          reason: "Verify the change.",
          riskLevel: "LOW",
          risk: "Runs local tests",
          primaryCommand: "npm test",
          fullCommand: "npm test",
        },
      }),
      64,
    ).map(plain);

    for (const line of lines) assert.equal(stringWidth(line), 64, line);
    assert.match(lines.join("\n"), /first failure/);
    assert.match(lines.join("\n"), /needs approval/);
  });
});

describe("composeFrame", () => {
  function frame(overrides: Partial<Parameters<typeof composeFrame>[0]> = {}) {
    const transcript = new Transcript();
    transcript.pushUser("hello there");
    transcript.appendAssistant("General Kenobi.");
    return composeFrame({
      width: 80,
      height: 24,
      header: "anyroute/anyroute · ~/projects",
      transcript: transcript.render(78, false),
      scroll: 0,
      statusLeft: "ready · session abc123",
      statusRight: "12 in · 4 out",
      composer: { text: "next question", cursor: 13 },
      agentName: "Cavehound",
      agentMode: "idle",
      ...overrides,
    });
  }

  it("fills the terminal exactly and never overflows", () => {
    const result = frame();
    assert.equal(result.lines.length, 24);
    for (const line of result.lines) assert.ok(stringWidth(line) <= 80, line);

    const text = result.lines.map(plain).join("\n");
    assert.match(text, /anyroute\/anyroute/);
    assert.match(text, /~\//);
    assert.match(text, /hello there/);
    assert.match(text, /next question/);
  });

  it("renders command overlays as a centered panel above the composer", () => {
    const result = frame({
      overlay: {
        title: "Commands · 1/2",
        body: ["› /models  ·  Browse models", "  /connect  ·  Connect a provider"],
        footer: "↑↓ move · Enter run · Esc close",
        highlight: 0,
      },
    });
    const lines = result.lines.map(plain);
    const top = lines.findIndex((line) => line.includes("╭"));
    const bottom = lines.findIndex((line) => line.includes("╰"));

    assert.equal(result.cursor, undefined, "the composer cursor hides behind the modal");
    assert.ok(top > 0, "the panel should sit below the header");
    assert.ok(bottom > top, "the panel should have a bottom border");
    assert.ok((lines[top] ?? "").indexOf("╭") > 0, "the panel should be horizontally centered");
    assert.match(lines.slice(top, bottom + 1).join("\n"), /Commands · 1\/2/);
    assert.match(lines.slice(top, bottom + 1).join("\n"), /\/models/);
    assert.match(lines.slice(top, bottom + 1).join("\n"), /Enter run/);
    assert.match(lines.join("\n"), /next question/, "the composer stays visible");
    for (const line of result.lines) assert.ok(stringWidth(line) <= 80, line);
  });

  it("renders a clickable sessions toggle in the top-left corner", () => {
    const base = frame({ showHeader: false });
    const closed = frame({ showHeader: false, sessionTab: { open: false } });
    const open = frame({ showHeader: false, sessionTab: { open: true } });

    assert.match(plain(closed.lines[0] ?? ""), /^</);
    assert.match(plain(open.lines[0] ?? ""), /^</);
    assert.equal(closed.bodyHeight, base.bodyHeight - 1, "the toggle reserves one chrome row");
    assert.equal(closed.lines.length, 24);
    for (const line of closed.lines) assert.ok(stringWidth(line) <= 80, line);
  });

  it("keeps the overlay inside a narrow frame", () => {
    const result = frame({
      width: 20,
      height: 10,
      overlay: {
        title: "Commands",
        body: ["› /models  ·  Browse models", "  /connect  ·  Connect a provider"],
        footer: "↑↓ move · Enter run · Esc close",
        highlight: 0,
      },
    });

    assert.equal(result.lines.length, 10);
    for (const line of result.lines) assert.ok(stringWidth(line) <= 20, line);
    assert.match(result.lines.map(plain).join("\n"), /╭ Commands/);
  });

  it("keeps the selected overlay row visible when content overflows", () => {
    const body = ["Active: anyroute", ...Array.from({ length: 12 }, (_, index) => `model-${index}`)];
    const result = frame({
      height: 16,
      overlay: {
        title: "Models · anyroute",
        body,
        footer: "↑↓ move · Enter use · Esc close",
        highlight: 12,
      },
    });
    const text = result.lines.map(plain).join("\n");

    assert.match(text, /model-11/, "the selected model should stay inside the visible panel");
    assert.match(text, /Enter use/);
    for (const line of result.lines) assert.ok(stringWidth(line) <= 80, line);
  });

  it("centers the retro ANYCODE wordmark only in an empty session", () => {
    const empty = frame({ transcript: [], showBrand: true });
    const emptyLines = empty.lines.map(plain);
    const emptyText = emptyLines.join("\n");
    assert.match(emptyText, /█/);
    assert.match(emptyText, /[\u2801-\u28ff]/);
    const mixed = emptyLines.find(
      (line) => line.includes("█") && /[\u2801-\u28ff]/.test(line),
    );
    assert.ok(mixed, "infinity mark should sit between ANY and CODE");
    const markIndex = mixed.search(/[\u2801-\u28ff]/);
    assert.ok(mixed.slice(0, markIndex).includes("█"), "ANY should be left of the mark");
    assert.ok(mixed.slice(markIndex).includes("█"), "CODE should be right of the mark");
    assert.ok(!emptyText.includes("TERMINAL AI"));
    assert.equal(empty.lines.length, 24);
    for (const line of empty.lines) assert.ok(stringWidth(line) <= 80, line);

    const started = frame({
      transcript: ["› hello"],
      showBrand: true,
    });
    assert.ok(!started.lines.map(plain).join("\n").includes("█"));
  });

  it("uses a compact ANYCODE mark on narrow terminals", () => {
    const result = frame({
      width: 20,
      height: 20,
      transcript: [],
      showBrand: true,
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /A N Y C O D E/);
    assert.match(text, /[\u2801-\u28ff]/);
    for (const line of result.lines) assert.ok(stringWidth(line) <= 20, line);
  });

  it("keeps queued prompts pinned while the conversation scrolls", () => {
    const transcript = Array.from({ length: 60 }, (_, index) => `conversation line ${index}`);
    const queuedPrompts = ["first queued request", "second queued request", "third queued request"];
    const bottom = frame({ transcript, queuedPrompts, scroll: 0 });
    const scrolled = frame({ transcript, queuedPrompts, scroll: 35 });
    const bottomText = bottom.lines.map(plain).join("\n");
    const scrolledText = scrolled.lines.map(plain).join("\n");

    for (const prompt of queuedPrompts) {
      assert.ok(bottomText.includes(prompt), `bottom view should show ${prompt}`);
      assert.ok(scrolledText.includes(prompt), `scrolled view should still show ${prompt}`);
    }
    assert.match(scrolledText, /QUEUED · 3/);
    for (const line of scrolled.lines) assert.ok(stringWidth(line) <= 80, line);
  });

  it("places the cursor on the composer line", () => {
    const result = frame();
    assert.ok(result.cursor);
    const line = result.lines[result.cursor.row] ?? "";
    assert.match(plain(line), /▌ next question/);
    assert.ok(result.cursor.col <= 80);
  });

  it("anchors the footer to the bottom edge below the composer", () => {
    const idle = frame();
    const composerIdx = idle.lines.findIndex((line) => line.includes("next question"));
    assert.ok(composerIdx >= 0, "composer should still be present");
    assert.match(plain(idle.lines.at(-1) ?? ""), /attach · commands · run/);
    assert.ok((plain(idle.lines.at(-2) ?? "").trim() === "") || composerIdx < idle.lines.length - 3, "footer should sit below the compact composer");

    const running = frame({
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        currentIntent: "step 1",
      },
    });
    assert.equal(running.lines.length, 24);
    assert.match(plain(running.lines.at(-1) ?? ""), /attach · commands · run/);
    assert.ok((plain(running.lines.at(-2) ?? "").trim() === "") || running.lines.findIndex((line) => line.includes("▌")) > 0, "running composer should remain compact and clear of the footer");
  });

  it("keeps the working composer clear and the hint in the footer", () => {
    const result = frame({
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        currentIntent: "thinking",
      },
    });
    const lines = result.lines.map(plain);
    const hintIdx = lines.findIndex((line) => line.includes("attach · commands · run"));
    const composerIdx = lines.findIndex((line) => line.includes("▌"));
    assert.ok(hintIdx > composerIdx, "Hint should sit below the composer");
    assert.ok(!(lines[hintIdx] ?? "").includes("▌"), "Hint should not use the composer rail");
    assert.ok(!lines.some((line) => /[▁▂▃▄▅▆▇█]/.test(line)), "Composer should not show waveform bars");
  });

  it("keeps working on small terminals", () => {
    const result = frame({ width: 40, height: 8, composer: { text: "hi", cursor: 2 } });
    assert.equal(result.lines.length, 8);
    for (const line of result.lines) assert.ok(stringWidth(line) <= 40, line);
  });

  it("renders the model line without a waveform in the composer", () => {
    const result = frame({
      agentMode: "running",
      model: { provider: "anyroute", model: "anyroute", autoApprove: true },
      agentStatus: {
        status: "working",
        currentIntent: "thinking",
      },
    });
    const lines = result.lines.map(plain);
    const modelIdx = lines.findIndex((line) => line.includes("model:"));
    assert.ok(modelIdx >= 0, "Model row should remain visible");
    assert.ok(!lines.some((line) => /[▁▂▃▄▅▆▇█]/.test(line)), "No waveform bars should be rendered");
    assert.match(lines[modelIdx] ?? "", /model:\s+anyroute\/anyroute\s+\(auto-approve\)/);
  });

  it("keeps the model row inside narrow terminals without a waveform", () => {
    const result = frame({
      width: 20,
      height: 12,
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      model: { provider: "anyroute", model: "anyroute", autoApprove: true },
      agentStatus: {
        status: "working",
        currentIntent: "thinking",
      },
    });
    const lines = result.lines.map(plain);
    const modelIdx = lines.findIndex((line) => line.includes("model:"));
    assert.ok(modelIdx >= 0, "Model row should remain visible");
    assert.match(lines[modelIdx] ?? "", /model:/);
    assert.ok(!lines.some((line) => /[▁▂▃▄▅▆▇█]/.test(line)), "No waveform bars should be rendered");
    for (const line of result.lines) assert.ok(stringWidth(line) <= 20, line);
  });

  it("keeps long status rows inside the frame on narrow terminals", () => {
    const result = frame({
      width: 20,
      height: 12,
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        currentIntent: "planning a long-running task",
        currentStep: 3,
        totalSteps: 9,
        relevantShortcuts: "Ctrl+C · Ctrl+L",
      },
    });
    for (const line of result.lines) assert.ok(stringWidth(line) <= 20, line);
  });

  it("shows only usage after removing the provider/cwd label", () => {
    const result = frame({
      showHeader: false,
      usage: { inputTokens: 21, outputTokens: 7 },
      model: { provider: "anyroute", model: "anyroute", autoApprove: true },
    });
    const text = result.lines.map(plain).join("\n");
    assert.ok(!text.includes("anyroute · ~/projects"), "provider/cwd label should be gone");
    assert.match(text, /21 in · 7 out/);
  });

  it("darkens the canvas but keeps only the composer on its lighter surface", () => {
    const result = frame({
      transcript: ["hello", "world"],
      composer: { text: "next question", cursor: 13 },
      usage: { inputTokens: 0, outputTokens: 0 },
      model: { provider: "anyroute", model: "anyroute", autoApprove: true },
    });
    const lines = result.lines.map(plain);
    const canvas = result.lines.filter((line) => line.includes("\u001b[48;5;16m"));
    const composer = result.lines.filter((line) => line.includes("\u001b[48;5;234m"));

    if (!colorEnabled) {
      assert.equal(canvas.length, 0);
      assert.equal(composer.length, 0);
      return;
    }

    assert.ok(canvas.length >= 4, "canvas rows should use the black background");
    assert.equal(composer.length, 5, "the composer surface should stay compact while reserving the top inset");
    const composerIdx = lines.findIndex((line) => line.includes("▌"));
    assert.ok(composerIdx > 0, "composer should be visible");
    for (let i = composerIdx; i < composerIdx + 4; i++) {
      assert.ok(
        (result.lines[i] ?? "").includes("\u001b[48;5;234m"),
        "composer rows should use the composer surface",
      );
      assert.ok(
        !(result.lines[i] ?? "").includes("\u001b[48;5;16m"),
        "composer rows should not use the canvas background",
      );
    }
    for (let i = composerIdx + 4; i < result.lines.length; i++) {
      assert.ok(
        !(result.lines[i] ?? "").includes("\u001b[48;5;234m"),
        "rows below the composer should not use the composer surface",
      );
      assert.ok(
        (result.lines[i] ?? "").includes("\u001b[48;5;16m"),
        "rows below the composer should use the black canvas",
      );
    }
  });

  it("shows approval panel inside activity card", () => {
    const transcript = new Transcript();
    transcript.pushActivity({
      id: "card-1",
      intent: "Searching for 'cavehound'",
      status: "warning",
      steps: [
        { id: "s1", tool: "list", status: "ok", summary: "111 entries", durationMs: 50 },
        { id: "s2", tool: "bash", status: "warning", summary: "Search for cavehound directory", durationMs: 2200 },
      ],
      expanded: true,
      permission: {
        tool: "bash",
        explanation: "Cavehound wants to search for files matching cavehound.",
        reason: "I need to find the cavehound project directory.",
        riskLevel: "LOW",
        risk: "Read-only directory search",
        primaryCommand: 'dir /s /b "C:\\Users\\ChipTech\\**\\cavehound*"',
        fullCommand: 'dir /s /b "C:\\Users\\ChipTech\\**\\cavehound*" 2>nul',
      },
    });
    const result = frame({
      transcript: transcript.render(78, false),
      scroll: 0,
      statusLeft: "ready",
      statusRight: "12 in · 4 out",
      composer: { text: "next question", cursor: 13 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Searching for 'cavehound'/);
    assert.match(text, /⚠ bash/);
    assert.match(text, /\[y\]/);
    assert.match(text, /\[a\]/);
    assert.match(text, /\[n\]/);
  });

  it("animates running tool glyphs as a wave", () => {
    const card: ActivityCard = {
      id: "card-wave",
      intent: "Running shell command",
      status: "running",
      steps: [{ id: "s1", tool: "bash", status: "running", summary: "ls" }],
      changes: [],
      expanded: true,
    };
    const transcript = new Transcript();
    transcript.pushActivity(card);

    const first = transcript.render(78, false, 0).join("\n");
    const later = transcript.render(78, false, 180).join("\n");
    const staticFrame = transcript.render(78, false).join("\n");

    assert.ok(!first.includes("⋯"), "running glyph should animate");
    assert.notEqual(first, later, "wave should move between frames");
    assert.match(staticFrame, /⋯/, "static rendering keeps the old glyph");
  });

  it("indicates scrollback when scrolled up", () => {
    const many = Array.from({ length: 100 }, (_value, index) => `line ${index}`);
    const result = frame({ transcript: many, scroll: 20 });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /20 lines below/);
    assert.match(text, /\[End\] jump to latest/);
  });

  it("derives placeholder from agent name when idle", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "idle",
      composer: { text: "", cursor: 0 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Ask Cavehound…/);
  });

  it("derives placeholder from custom agent name", () => {
    const result = frame({
      agentName: "Atlas",
      agentMode: "idle",
      composer: { text: "", cursor: 0 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Ask Atlas…/);
  });

  it("shows 'Type a message…' when no agent name", () => {
    const result = frame({
      agentName: undefined,
      agentMode: "idle",
      composer: { text: "", cursor: 0 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Type a message…/);
  });

  it("keeps the padded placeholder and cursor inside the composer margin", () => {
    const result = frame({
      width: 20,
      height: 12,
      agentName: "Cavehound",
      agentMode: "idle",
      composer: { text: "", cursor: 40 },
    });
    const line = result.lines.find((entry) => plain(entry).includes("Ask")) ?? "";
    assert.ok(line.length > 0, "placeholder should remain visible");
    assert.match(plain(line), /^\s{2}▌\s+Ask\s.*$/);
    assert.ok(result.cursor, "cursor should be present");
    assert.ok(result.cursor!.col <= 16, "cursor should stay inside the padded inner width");
    assert.ok(stringWidth(plain(line)) <= 20, "placeholder should stay within the terminal width");
  });

  it("shows 'Type to queue your next instruction…' when running", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "running",
      composer: { text: "", cursor: 0 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Type to queue your next instruction…/);
  });

  it("shows 'Run a shell command…' in shell mode", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "shell",
      composer: { text: "", cursor: 0 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Run a shell command…/);
  });

  it("shows 'Search files…' in file picker mode", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "file-picker",
      composer: { text: "", cursor: 0 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Search files…/);
  });

  it("shows typed text instead of placeholder", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "idle",
      composer: { text: "hello there", cursor: 11 },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /hello there/);
    assert.match(text, /▌ hello there/);
  });

  it("soft-wraps long prompts and keeps the cursor on the visible end row", () => {
    const text = "d".repeat(200);
    const result = frame({
      width: 20,
      height: 14,
      composer: { text, cursor: text.length },
    });
    const lines = result.lines.map(plain);
    const inputRows = lines.filter((line) => line.includes("dddd"));

    assert.ok(inputRows.length > 1, "long prompt should use multiple composer rows");
    assert.ok(inputRows.length < 200, "long prompt should fit within the available composer viewport");
    assert.ok(inputRows.every((line) => stringWidth(line) <= 20), "wrapped prompt must not overflow the terminal");
    assert.ok(result.cursor, "cursor should be present");
    assert.ok(lines[result.cursor.row]?.includes("d"), "cursor row should contain the end of the prompt");
    assert.ok(result.cursor.col <= 16, "cursor should stay within the composer text width");
  });

  // Status strip tests

  it("idle state shows no status strip", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "idle",
      composer: { text: "", cursor: 0 },
    });
    const text = result.lines.map(plain).join("\n");
    // No status strip line should appear
    assert.ok(!text.includes("Working"), "Should not contain 'Working'");
    assert.ok(!text.includes("Waiting for approval"), "Should not contain 'Waiting for approval'");
    assert.ok(!text.includes("Failed"), "Should not contain 'Failed'");
    assert.ok(!text.includes("Cancelled"), "Should not contain 'Cancelled'");
    assert.ok(!text.includes("⠴"), "Should not contain spinner");
    assert.ok(!text.includes("⚠"), "Should not contain warning icon");
    assert.ok(!text.includes("✗"), "Should not contain error icon");
  });

  it("working state shows the node pulse, status, step, and duration", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        frame: "◉─○─○",
        currentIntent: "step 4",
        currentStep: 4,
        totalSteps: 10,
        durationMs: 669000,
        relevantShortcuts: "Tab queue · Ctrl+Q manage",
      },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /◉─○─○ Working/);
    assert.match(text, /step 4/);
    assert.match(text, /11m 9s/);
    assert.ok(text.includes("Tab queue"), "Working status should expose queue controls");
    assert.ok(text.includes("Ctrl+Q manage"), "Working status should expose queue management");
  });

  it("renders the working infinity icon beside the status text", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        glyph: { width: 4, lines: ["AAAA", "BBBB", "CCCC"] },
        currentIntent: "thinking",
        durationMs: 1000,
        relevantShortcuts: "Tab queue",
      },
    });
    const lines = result.lines.map(plain);
    const statusRow = lines.findIndex((line) => line.includes("Working"));
    assert.ok(statusRow >= 0, "working status should render");
    assert.ok(lines[statusRow]!.includes("BBBB"), "status text should sit on the middle icon row");
    assert.ok(!lines[statusRow]!.includes("AAAA"), "top icon row should not carry the status text");
    assert.ok(!lines[statusRow]!.includes("CCCC"), "bottom icon row should not carry the status text");
    assert.ok(lines[statusRow]!.includes("Tab queue"), "shortcuts stay on the status row");
    assert.ok(lines.some((line) => line.includes("AAAA")), "top icon row should render on its own line");
  });

  it("falls back to the single-row glyph when no icon is supplied", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        frame: "∞",
        currentIntent: "thinking",
        durationMs: 1000,
        relevantShortcuts: "Tab queue",
      },
    });
    const lines = result.lines.map(plain);
    const statusLine = lines.find((line) => line.includes("∞ Working"));
    assert.ok(statusLine, "working status should render");
    assert.ok(statusLine.includes("Tab queue"), "shortcuts stay on the same row");
  });

  it("status strip shortcuts are not prefixed with ▌", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        currentIntent: "step 4",
        currentStep: 4,
        totalSteps: 10,
        durationMs: 669000,
        relevantShortcuts: "f1 help · f2 output",
      },
    });
    const text = result.lines.map(plain).join("\n");
    // The ▌ character should only appear on composer lines, not status strip
    const lines = text.split("\n");
    const statusLine = lines.find((l) => l.includes("f1 help"));
    assert.ok(statusLine, "shortcut line should exist");
    assert.ok(!statusLine.includes("▌"), "Status strip should not have ▌ rail");
  });

  it("no bare ▇ glyph is rendered", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        currentIntent: "step 4",
        currentStep: 4,
        totalSteps: 10,
        durationMs: 669000,
      },
    });
    const text = result.lines.map(plain).join("\n");
    assert.ok(!text.includes("▇"), "Should not contain bare ▇ glyph");
  });

  it("approval state shows Waiting for approval and y/a/n shortcuts", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "idle",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "awaiting_approval",
        currentIntent: "bash",
        currentStep: undefined,
        totalSteps: undefined,
        durationMs: undefined,
        relevantShortcuts: "y run · a always · n cancel",
      },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /⚠ Waiting for approval/);
    assert.match(text, /y run/);
    assert.match(text, /a always/);
    assert.match(text, /n cancel/);
  });

  it("error state shows Failed and retry/output shortcuts", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "idle",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "error",
        currentIntent: "bash exited with code 1",
        currentStep: undefined,
        totalSteps: undefined,
        durationMs: undefined,
        relevantShortcuts: "r retry · o output",
      },
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /✗ Failed/);
    assert.match(text, /r retry/);
    assert.match(text, /o output/);
  });

  it("one blank line between status strip and composer", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "running",
      composer: { text: "", cursor: 0 },
      agentStatus: {
        status: "working",
        currentIntent: "step 4",
        currentStep: 4,
        totalSteps: 10,
        durationMs: 669000,
      },
    });
    const text = result.lines.map(plain).join("\n");
    const lines = text.split("\n");
    // Find the working status and composer lines.
    const statusIdx = lines.findIndex((l) => l.includes("Working"));
    const composerIdx = lines.findIndex((l) => l.includes("▌"));
    assert.ok(statusIdx >= 0, "Status line should exist");
    assert.ok(composerIdx >= 0, "Composer line should exist");
    assert.ok(composerIdx > statusIdx, "Composer should be after status");
    // The composer reserves its own top inset, so the gap can include the status
    // separation row plus the composer's blank top row, but nothing else.
    const between = lines.slice(statusIdx + 1, composerIdx);
    assert.ok(between.every((l) => l.trim() === ""), "Lines between status and composer should be blank");
    assert.ok(between.length >= 1 && between.length <= 2, "Allow the composer top inset while keeping the status gap compact");
  });

  it("adds breathing room between the transcript and composer when there is no status strip", () => {
    const result = frame({
      agentName: "Cavehound",
      agentMode: "idle",
      composer: { text: "hello", cursor: 5 },
    });
    const lines = result.lines.map(plain);
    const composerIdx = lines.findIndex((line) => line.includes("▌"));
    assert.ok(composerIdx > 0, "composer should be visible");
    assert.ok(lines[composerIdx - 1]?.trim() === "", "there should be a blank line before the composer");
  });

});

describe("Tui session picker", () => {
  function fixtureSession(id: string, messages: Array<Record<string, unknown>> = []) {
    return {
      id,
      title: `Session ${id}`,
      provider: "test",
      model: "test",
      messages,
      save: () => undefined,
    };
  }

  function makeTui(overrides: Record<string, unknown> = {}): Tui {
    const runtime = {
      session: fixtureSession("current"),
      agent: {},
      providerId: "test",
      model: "test",
      broker: {},
      listSessions: async () => [
        {
          id: "older",
          title: "Older work",
          updatedAt: "2026-11-06T10:00:00.000Z",
          messageCount: 2,
        },
      ],
      loadSession: async (id: string) =>
        fixtureSession(id, [
          { role: "user", content: "older question" },
          { role: "assistant", content: "older answer" },
        ]),
      rebuild: async ({ session }: { session: unknown }) => ({
        agent: {},
        session,
        providerId: "test",
        model: "test",
      }),
      ...overrides,
    };
    const tui = new Tui(runtime);
    tui.cleaned = true;
    return tui;
  }

  it("opens the picker from the top-left tab and lists saved sessions", async () => {
    const tui = makeTui();

    const handled = tui.handleMouse({ type: "mouse", button: 0, x: 3, y: 1, release: false });
    assert.equal(handled, true);
    assert.equal(tui.sessionPickerOpen, true);

    await tui.sessionPickerTask;
    assert.equal(tui.sessionEntries.length, 1);
    assert.equal(tui.sessionEntries[0]?.id, "older");

    tui.handleMouse({ type: "mouse", button: 0, x: 3, y: 1, release: false });
    assert.equal(tui.sessionPickerOpen, false);
  });

  it("opens the picker from raw X10 mouse bytes on the top row", () => {
    const tui = makeTui();

    // Real terminal input path: \e[M + (button, x, y) each offset by 32.
    tui.onData("\u001b[M" + String.fromCharCode(32, 35, 33));

    assert.equal(tui.sessionPickerOpen, true);
  });

  it("likewise opens the picker from raw SGR mouse bytes", () => {
    const tui = makeTui();

    tui.onData("\u001b[<0;3;1M");

    assert.equal(tui.sessionPickerOpen, true);
  });

  it("loads a session when Enter is pressed in the picker", async () => {
    const tui = makeTui();
    tui.openSessionPicker();
    await tui.sessionPickerTask;

    assert.equal(tui.sessionSelected, 0);
    tui.handleKey({ type: "key", name: "enter" });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(tui.state.session.id, "older");
    assert.equal(tui.sessionPickerOpen, false);
  });

  it("moves the picker selection with the arrow keys", async () => {
    const tui = makeTui({
      listSessions: async () => [
        { id: "one", title: "One", updatedAt: "2026-11-06T10:00:00.000Z", messageCount: 1 },
        { id: "two", title: "Two", updatedAt: "2026-11-06T11:00:00.000Z", messageCount: 2 },
      ],
    });
    tui.openSessionPicker();
    await tui.sessionPickerTask;

    tui.handleKey({ type: "key", name: "down" });
    assert.equal(tui.sessionSelected, 1);
    tui.handleKey({ type: "key", name: "up" });
    assert.equal(tui.sessionSelected, 0);
  });

  it("loads a session when its row is clicked in the picker", async () => {
    const tui = makeTui();
    tui.openSessionPicker();
    await tui.sessionPickerTask;

    tui.frame = tui.compose(80, 24, []);
    const row = tui.frame.overlayBody?.find(
      (entry: { row: number; index: number }) => entry.index === 0,
    );
    assert.ok(row, "the picker should expose its clickable rows");

    const handled = tui.handleMouse({
      type: "mouse",
      button: 0,
      x: 10,
      y: row.row + 1,
      release: false,
    });

    assert.equal(handled, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(tui.state.session.id, "older");
  });

  it("loads the selected session history into the transcript", async () => {
    const tui = makeTui();
    await tui.openSessionPicker();

    await tui.selectSession(tui.sessionEntries[0]!);

    assert.equal(tui.state.session.id, "older");
    assert.equal(tui.sessionPickerOpen, false);
    const rendered = tui.transcript.render(80, false).join("\n");
    assert.match(plain(rendered), /older question/);
    assert.match(plain(rendered), /older answer/);
  });

  it("ignores clicks outside the sessions tab", () => {
    const tui = makeTui();

    const handled = tui.handleMouse({ type: "mouse", button: 0, x: 20, y: 5, release: false });

    assert.equal(handled, false);
    assert.equal(tui.sessionPickerOpen, false);
  });

  it("toggles on mouse press but not on release", () => {
    const tui = makeTui();

    // Button press opens the picker.
    assert.equal(tui.handleMouse({ type: "mouse", button: 0, x: 3, y: 1, release: false }), true);
    assert.equal(tui.sessionPickerOpen, true);

    // Button release must not immediately close it again.
    assert.equal(tui.handleMouse({ type: "mouse", button: 0, x: 3, y: 1, release: true }), false);
    assert.equal(tui.sessionPickerOpen, true);

    // A second press closes it.
    assert.equal(tui.handleMouse({ type: "mouse", button: 0, x: 3, y: 1, release: false }), true);
    assert.equal(tui.sessionPickerOpen, false);
  });
});

describe("Tui jump to latest", () => {
  function makeTui(): Tui {
    const runtime = {
      session: { messages: [] },
      agent: {},
      providerId: "test",
      model: "test",
      broker: {},
    };
    const tui = new Tui(runtime);
    tui.cleaned = true;
    return tui;
  }

  it("snaps back to the newest line with End or Ctrl+End", () => {
    const tui = makeTui();

    tui.scroll = 12;
    tui.scrollTarget = 12;
    tui.handleKey({ type: "key", name: "end" });
    assert.equal(tui.scroll, 0);
    assert.equal(tui.scrollTarget, 0);

    tui.scroll = 8;
    tui.scrollTarget = 8;
    tui.editor.setText("draft");
    tui.handleKey({ type: "key", name: "end", ctrl: true });
    assert.equal(tui.scroll, 0);
    assert.equal(tui.scrollTarget, 0);
  });

  it("leaves End to the editor while the draft is non-empty", () => {
    const tui = makeTui();
    tui.editor.setText("draft");
    tui.scroll = 5;
    tui.scrollTarget = 5;
    tui.handleKey({ type: "key", name: "end" });
    assert.equal(tui.scroll, 5);
    assert.equal(tui.scrollTarget, 5);
  });
});
