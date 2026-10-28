import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import type { Agent } from "../agent/agent.js";
import type { PermissionBroker } from "../agent/permissions.js";
import { Session, type SessionMeta } from "../agent/session.js";
import { defaultModelFor } from "../config.js";
import { errorMessage } from "../errors.js";
import { builtinTools } from "../tools/index.js";
import { color } from "../util/ansi.js";
import { Spinner } from "../util/spinner.js";
import { formatNumber, oneLine } from "../util/text.js";
import { createAskPermission } from "./ask.js";
import { Renderer } from "./renderer.js";

export interface RebuildChanges {
  session?: Session;
  providerId?: string;
  model?: string;
}

export interface RebuildResult {
  agent: Agent;
  session: Session;
  providerId: string;
  model: string;
}

export interface ReplRuntime {
  cwd: string;
  session: Session;
  agent: Agent;
  providerId: string;
  model: string;
  broker: PermissionBroker;
  rebuild(changes: RebuildChanges): Promise<RebuildResult>;
  listSessions(): Promise<SessionMeta[]>;
  loadSession(id: string): Promise<Session>;
}

const HELP = `Commands:
  /help              Show this help
  /new               Start a new session (alias: /clear)
  /model [name]      Show or change the model
  /provider [id]     Show or change the provider (optionally with a model)
  /sessions          List saved sessions for this directory
  /resume [id]       Resume a session (default: most recent)
  /yolo              Toggle auto-approve for the rest of the session
  /usage             Show token usage for this session
  /tools             List available tools
  /exit              Quit (alias: /quit)`;

export async function runRepl(runtime: ReplRuntime): Promise<void> {
  let { session, agent, providerId, model } = runtime;
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
    provider: providerId,
    model,
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
    const before = { ...session.usage };

    try {
      for await (const event of agent.run(text, { signal: controller.signal })) {
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

    renderer.usage(session.usage, before);
    await session.save().catch(() => undefined);
  }

  async function handleCommand(raw: string): Promise<boolean> {
    const parts = raw.slice(1).trim().split(/\s+/);
    const command = parts[0] ?? "";
    const argument = parts.slice(1).join(" ");

    switch (command) {
      case "help":
        renderer.info(HELP);
        return false;

      case "exit":
      case "quit":
        return true;

      case "new":
      case "clear": {
        const next = Session.create({ cwd: runtime.cwd, provider: providerId, model });
        const rebuilt = await runtime.rebuild({ session: next, providerId, model });
        session = rebuilt.session;
        agent = rebuilt.agent;
        renderer.info(`Started session ${session.id}`);
        return false;
      }

      case "model": {
        if (!argument) {
          renderer.info(`Model: ${model}`);
          return false;
        }
        try {
          const rebuilt = await runtime.rebuild({ providerId, model: argument });
          agent = rebuilt.agent;
          model = rebuilt.model;
          session.model = model;
          renderer.info(`Model: ${model}`);
        } catch (error) {
          renderer.error(errorMessage(error));
        }
        return false;
      }

      case "provider": {
        const [nextProvider, nextModel] = argument.split(/\s+/);
        if (!nextProvider) {
          renderer.info(`Provider: ${providerId} (model: ${model})`);
          return false;
        }
        try {
          const rebuilt = await runtime.rebuild({
            providerId: nextProvider,
            model: nextModel || defaultModelFor(nextProvider) || model,
          });
          agent = rebuilt.agent;
          providerId = rebuilt.providerId;
          model = rebuilt.model;
          session.provider = providerId;
          session.model = model;
          renderer.info(`Provider: ${providerId}/${model}`);
        } catch (error) {
          renderer.error(errorMessage(error));
        }
        return false;
      }

      case "sessions": {
        const sessions = await runtime.listSessions();
        if (sessions.length === 0) {
          renderer.info("No saved sessions in this directory.");
          return false;
        }
        for (const meta of sessions) {
          const marker = meta.id === session.id ? color.green("*") : " ";
          renderer.info(
            `${marker} ${meta.id}  ${meta.updatedAt.slice(0, 16).replace("T", " ")}  ${meta.messageCount} msgs  ${oneLine(meta.title, 60)}`,
          );
        }
        return false;
      }

      case "resume": {
        const sessions = await runtime.listSessions();
        const id = argument || sessions[0]?.id;
        if (!id) {
          renderer.info("No session to resume.");
          return false;
        }
        try {
          const loaded = await runtime.loadSession(id);
          const rebuilt = await runtime.rebuild({
            session: loaded,
            providerId: loaded.provider || providerId,
            model: loaded.model || model,
          });
          session = rebuilt.session;
          agent = rebuilt.agent;
          providerId = rebuilt.providerId;
          model = rebuilt.model;
          renderer.info(
            `Resumed ${session.id} (${session.messages.length} messages, ${oneLine(session.title, 50)})`,
          );
        } catch (error) {
          renderer.error(errorMessage(error));
        }
        return false;
      }

      case "yolo":
        runtime.broker.autoApprove = !runtime.broker.autoApprove;
        renderer.info(
          runtime.broker.autoApprove
            ? "Auto-approve ON: tools run without asking."
            : "Auto-approve OFF.",
        );
        return false;

      case "usage": {
        const usage = session.usage;
        renderer.info(
          `Tokens: ${formatNumber(usage.inputTokens)} in · ${formatNumber(usage.outputTokens)} out · ${formatNumber(usage.cacheReadTokens)} cached`,
        );
        return false;
      }

      case "tools": {
        for (const tool of builtinTools) {
          renderer.info(`${tool.name.padEnd(6)} ${tool.readOnly ? "(read-only)" : ""}`);
        }
        return false;
      }

      default:
        renderer.info(`Unknown command /${command}. Try /help.`);
        return false;
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
        if (await handleCommand(trimmed)) break;
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
