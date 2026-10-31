import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { PermissionBroker } from "../agent/permissions.js";
import type { SessionMeta } from "../agent/session.js";
import { errorMessage } from "../errors.js";
import { color } from "../util/ansi.js";
import { Spinner } from "../util/spinner.js";
import { createAskPermission } from "./ask.js";
import { handleSlashCommand } from "./commands.js";
import { Renderer } from "./renderer.js";
import type { ChatRuntime, ChatState, InteractiveRuntime } from "./runtime.js";

export type { RebuildChanges, RebuildResult, ChatRuntime, ChatState } from "./runtime.js";

/** Backwards-compatible name for the interactive runtime. */
export type ReplRuntime = InteractiveRuntime;
export type { SessionMeta };
export type { PermissionBroker };

/** Line-based fallback used when the full-screen TUI is disabled. */
export async function runRepl(runtime: InteractiveRuntime): Promise<void> {
  const state: ChatState = {
    session: runtime.session,
    agent: runtime.agent,
    providerId: runtime.providerId,
    model: runtime.model,
  };

  const renderer = new Renderer();
  const spinner = new Spinner("thinking");
  const rl = createInterface({ input, output, terminal: true, historySize: 300 });
  const closed = new AbortController();
  let busy: AbortController | undefined;
  let interrupts = 0;

  rl.on("close", () => closed.abort());

  rl.on("SIGINT", () => {
    if (busy) {
      busy.abort();
      renderer.info("Interrupting…");
      return;
    }
    interrupts++;
    if (interrupts >= 2) {
      rl.close();
      return;
    }
    renderer.info("Press Ctrl+C again to exit.");
    setTimeout(() => {
      interrupts = 0;
    }, 1500);
  });

  const ask = createAskPermission({ rl, renderer, spinner, signal: closed.signal });
  runtime.broker.handler = ask;

  renderer.banner({
    cwd: runtime.cwd,
    provider: state.providerId,
    model: state.model,
    autoApprove: runtime.broker.autoApprove,
  });

  async function runTurn(text: string): Promise<void> {
    if (busy) {
      renderer.notice("A turn is already running. Press Ctrl+C to interrupt it.");
      return;
    }

    const controller = new AbortController();
    busy = controller;
    renderer.begin();
    spinner.start("thinking");
    const before = { ...state.session.usage };

    try {
      for await (const event of state.agent.run(text, { signal: controller.signal })) {
        switch (event.type) {
          case "turn_start":
            spinner.start(event.step > 1 ? `step ${event.step}` : "thinking");
            break;
          case "text":
            spinner.stop();
            renderer.text(event.text);
            break;
          case "reasoning":
            break;
          case "tool_start":
            spinner.stop();
            renderer.toolStart(event.call, event.input);
            break;
          case "tool_end":
            spinner.stop();
            renderer.toolEnd(event.call, event.content, event.isError, event.durationMs);
            break;
          case "usage":
            break;
          case "compaction":
            renderer.notice(
              `Trimmed ${event.removedMessages} old messages to stay inside the context window.`,
            );
            break;
          case "notice":
            spinner.stop();
            renderer.notice(event.message);
            break;
          case "error":
            spinner.stop();
            renderer.error(event.message, event.hint);
            break;
          case "done":
            spinner.stop();
            if (event.aborted) renderer.notice("Interrupted.");
            break;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) renderer.error(errorMessage(error));
    } finally {
      spinner.stop();
      renderer.endText();
      busy = undefined;
    }

    renderer.usage(state.session.usage, before);
    await state.session.save().catch(() => undefined);
  }

  const sink = {
    info: (message: string) => renderer.info(message),
    error: (message: string, hint?: string) => renderer.error(message, hint),
  };

  /** Interactive model picker for the REPL: list models and pick by number. */
  async function showModelPickerRepl(): Promise<void> {
    try {
      const res = await fetch("http://127.0.0.1:3456/v1/models");
      if (!res.ok) {
        renderer.error("Could not reach anyroute gateway. Is it running?");
        return;
      }
      const data = await res.json() as { data?: Array<{ id: string }> };
      const models = (data.data ?? [])
        .map((m) => m.id)
        .filter((id) => !["anyroute", "auto", "free"].includes(id));
      if (models.length === 0) {
        renderer.info("No models available from anyroute.");
        return;
      }

      renderer.info("Available models:");
      models.forEach((m, i) => {
        renderer.info(`  ${i + 1}. ${m}`);
      });

      const answer = await rl.question(
        color.cyan("Pick a model number (or Enter to cancel): "),
        { signal: closed.signal },
      );
      const n = Number.parseInt(answer.trim(), 10);
      if (!Number.isFinite(n) || n < 1 || n > models.length) {
        renderer.info("Cancelled.");
        return;
      }

      const model = models[n - 1];
      const rebuilt = await runtime.rebuild({ providerId: "anyroute", model });
      Object.assign(state, rebuilt);
      state.session.provider = state.providerId;
      state.session.model = state.model;
      renderer.info(`Model: ${state.providerId}/${state.model}`);
    } catch (error) {
      renderer.error(errorMessage(error));
    }
  }

  try {
    for (;;) {
      let line: string;
      try {
        line = await rl.question(color.cyan("› "), { signal: closed.signal });
      } catch {
        break;
      }

      let trimmed = line.trim();
      if (!trimmed) continue;

      while (trimmed.endsWith("\\")) {
        try {
          const continuation = await rl.question(color.gray("… "), { signal: closed.signal });
          trimmed = `${trimmed.slice(0, -1)}\n${continuation}`;
        } catch {
          break;
        }
      }

      if (trimmed.startsWith("/")) {
        if (await handleSlashCommand(trimmed, runtime, state, sink)) break;
        continue;
      }

      await runTurn(trimmed);
    }
  } finally {
    spinner.stop();
    closed.abort();
    rl.close();
  }
}
