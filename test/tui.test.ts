/*
┌──────────────────────────────────────────────────────────────────┐
│ test/tui.test.ts — TUI frame, palette, editor, keys, transcript   │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Session } from "../src/agent/session.js";
import { Editor } from "../src/ui/editor.js";
import { KeyParser } from "../src/ui/keys.js";
import { composeFrame } from "../src/ui/screen.js";
import { footerFor } from "../src/ui/tui.js";
import { Transcript } from "../src/ui/transcript.js";
import { stringWidth, stripAnsi } from "../src/util/width.js";
import { wrapText } from "../src/util/wrap.js";
import type { ActivityCard } from "../src/ui/activity.js";

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

describe("footerFor", () => {
  it("drops hint groups so the footer always fits", () => {
    assert.match(footerFor(200), /ctrl\+d quit/);
    for (const width of [20, 40, 60, 80]) {
      assert.ok(footerFor(width).length <= Math.max(2, width - 2), String(width));
    }
    assert.equal(footerFor(20), "enter send");
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
      headerLeft: "anycode v0.2.0",
      headerRight: "anyroute/anyroute",
      transcript: transcript.render(78, false),
      scroll: 0,
      statusLeft: "ready · session abc123",
      statusRight: "12 in · 4 out",
      composer: { text: "next question", cursor: 13 },
      footer: "enter send · ctrl+d quit",
      ...overrides,
    });
  }

  it("fills the terminal exactly and never overflows", () => {
    const result = frame();
    assert.equal(result.lines.length, 24);
    for (const line of result.lines) assert.ok(stringWidth(line) <= 80, line);

    const text = result.lines.map(plain).join("\n");
    assert.match(text, /anycode v0\.2\.0/);
    assert.match(text, /anyroute\/anyroute/);
    assert.match(text, /hello there/);
    assert.match(text, /next question/);
    assert.match(text, /enter send/);
  });

  it("places the cursor on the composer line", () => {
    const result = frame();
    assert.ok(result.cursor);
    const line = result.lines[result.cursor.row] ?? "";
    assert.match(plain(line), /▌ next question/);
    assert.ok(result.cursor.col <= 80);
  });

  it("keeps working on small terminals", () => {
    const result = frame({ width: 40, height: 8, composer: { text: "hi", cursor: 2 } });
    assert.equal(result.lines.length, 8);
    for (const line of result.lines) assert.ok(stringWidth(line) <= 40, line);
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
        command: 'dir /s /b "C:\\Users\\ChipTech\\**\\cavehound*" 2>nul',
        risk: "searches the entire user folder",
      },
    });
    const result = frame({
      transcript: transcript.render(78, false),
      scroll: 0,
      statusLeft: "ready",
      statusRight: "12 in · 4 out",
      composer: { text: "next question", cursor: 13 },
      footer: "enter send · ctrl+d quit",
    });
    const text = result.lines.map(plain).join("\n");
    assert.match(text, /Searching for 'cavehound'/);
    assert.match(text, /⚠ bash/);
    assert.match(text, /\[y\]/);
    assert.match(text, /\[a\]/);
    assert.match(text, /\[n\]/);
  });

  it("indicates scrollback when scrolled up", () => {
    const many = Array.from({ length: 100 }, (_value, index) => `line ${index}`);
    const result = frame({ transcript: many, scroll: 20 });
    assert.match(result.lines.map(plain).join("\n"), /20 lines below/);
  });
});
