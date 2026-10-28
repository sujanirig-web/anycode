import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { Agent, type AgentEvent } from "../src/agent/agent.js";
import { Session } from "../src/agent/session.js";
import { MockProvider, textTurn, toolTurn, type MockScript } from "../src/llm/mock.js";
import type { Message } from "../src/types.js";
import { cleanup, tempDir } from "./helpers.js";

async function run(
  script: MockScript,
  options: {
    root: string;
    session?: Session;
    maxSteps?: number;
    contextTokens?: number;
    approve?: boolean;
  },
): Promise<{ events: AgentEvent[]; session: Session }> {
  const session =
    options.session ??
    Session.create({ cwd: options.root, provider: "mock", model: "mock-1" });
  const agent = new Agent({
    provider: new MockProvider(script),
    model: "mock-1",
    cwd: options.root,
    session,
    system: "test system prompt",
    approve: async () => options.approve ?? true,
    ...(options.maxSteps !== undefined ? { maxSteps: options.maxSteps } : {}),
    ...(options.contextTokens !== undefined ? { contextTokens: options.contextTokens } : {}),
  });

  const events: AgentEvent[] = [];
  for await (const event of agent.run("do the thing")) events.push(event);
  return { events, session };
}

function finalText(events: AgentEvent[]): string {
  return events
    .filter((event): event is Extract<AgentEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("");
}

describe("agent loop", () => {
  it("executes a tool call and feeds the result back to the model", async () => {
    const root = await tempDir();
    try {
      const requests: Message[][] = [];
      const script: MockScript = (request, turn) => {
        requests.push([...request.messages]);
        if (turn === 0) {
          return toolTurn({
            name: "write",
            arguments: JSON.stringify({ path: "hello.txt", content: "hi there" }),
          });
        }
        return textTurn("File written.");
      };

      const { events, session } = await run(script, { root });

      assert.equal(finalText(events).trim(), "File written.");
      assert.equal(await fs.readFile(path.join(root, "hello.txt"), "utf8"), "hi there");

      const toolEnd = events.find(
        (event): event is Extract<AgentEvent, { type: "tool_end" }> =>
          event.type === "tool_end",
      );
      assert.ok(toolEnd);
      assert.equal(toolEnd.isError, false);

      const done = events.find(
        (event): event is Extract<AgentEvent, { type: "done" }> => event.type === "done",
      );
      assert.ok(done);
      assert.equal(done.steps, 1);
      assert.equal(done.aborted, false);

      // The second model call must include the assistant tool call and result.
      const second = requests[1]!;
      assert.ok(second.some((message) => message.role === "assistant" && message.toolCalls?.length));
      assert.ok(second.some((message) => message.role === "tool"));

      // Session is persisted for resume.
      const saved = JSON.parse(
        await fs.readFile(
          path.join(root, ".anycode", "sessions", `${session.id}.json`),
          "utf8",
        ),
      ) as { messages: Message[] };
      assert.ok(saved.messages.length >= 4);
      assert.ok(saved.messages.some((message) => message.role === "tool"));
    } finally {
      await cleanup(root);
    }
  });

  it("reports denied permissions to the model instead of crashing", async () => {
    const root = await tempDir();
    try {
      const script: MockScript = (_request, turn) => {
        if (turn === 0) {
          return toolTurn({
            name: "write",
            arguments: JSON.stringify({ path: "nope.txt", content: "no" }),
          });
        }
        return textTurn("I could not write the file because permission was denied.");
      };

      const { events } = await run(script, { root, approve: false });
      const toolEnd = events.find(
        (event): event is Extract<AgentEvent, { type: "tool_end" }> =>
          event.type === "tool_end",
      );
      assert.ok(toolEnd?.isError);
      assert.match(toolEnd.content, /denied permission/);
      await assert.rejects(fs.stat(path.join(root, "nope.txt")));
    } finally {
      await cleanup(root);
    }
  });

  it("handles unknown tools and malformed JSON arguments", async () => {
    const root = await tempDir();
    try {
      const script: MockScript = (_request, turn) => {
        if (turn === 0) {
          return [
            { type: "tool_call", call: { id: "a", name: "does_not_exist", arguments: "{}" } },
            { type: "tool_call", call: { id: "b", name: "read", arguments: "{not json" } },
            { type: "done", reason: "tool_calls" },
          ];
        }
        return textTurn("Recovered.");
      };

      const { events } = await run(script, { root });
      const failures = events.filter(
        (event): event is Extract<AgentEvent, { type: "tool_end" }> =>
          event.type === "tool_end" && event.isError,
      );
      assert.equal(failures.length, 2);
      assert.match(failures[0]!.content, /Unknown tool/);
      assert.match(failures[1]!.content, /Invalid JSON arguments/);
      assert.equal(finalText(events).trim(), "Recovered.");
    } finally {
      await cleanup(root);
    }
  });

  it("stops at maxSteps and warns the user", async () => {
    const root = await tempDir();
    try {
      const script: MockScript = () =>
        toolTurn({
          name: "read",
          arguments: JSON.stringify({ path: "missing.txt" }),
        });

      const { events } = await run(script, { root, maxSteps: 2 });
      const done = events.find(
        (event): event is Extract<AgentEvent, { type: "done" }> => event.type === "done",
      );
      assert.ok(done);
      assert.equal(done.steps, 2);
      assert.ok(
        events.some((event) => event.type === "error" && /maxSteps/.test(event.message)),
      );
    } finally {
      await cleanup(root);
    }
  });

  it("compacts history at user-turn boundaries", async () => {
    const root = await tempDir();
    try {
      const session = Session.create({ cwd: root, provider: "mock", model: "mock-1" });
      const big = "x".repeat(600);
      for (let index = 0; index < 8; index++) {
        session.messages.push({ role: "user", content: big });
        session.messages.push({ role: "assistant", content: big });
      }
      const before = session.messages.length;

      let seen = 0;
      const script: MockScript = (request) => {
        seen = request.messages.length;
        return textTurn("ok");
      };

      const { events } = await run(script, { root, session, contextTokens: 50 });
      const compaction = events.find(
        (event): event is Extract<AgentEvent, { type: "compaction" }> =>
          event.type === "compaction",
      );
      assert.ok(compaction);
      assert.ok(compaction.removedMessages > 0);
      assert.ok(session.messages.length < before + 1);
      // Trimming stops once the history is down to a handful of messages.
      assert.ok(seen <= 6, `expected a small history, saw ${seen} messages`);
      assert.equal(session.messages[0]?.role, "user");
    } finally {
      await cleanup(root);
    }
  });
});
