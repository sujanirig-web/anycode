import type { PermissionBroker } from "../agent/permissions.js";
import { Session } from "../agent/session.js";
import { defaultModelFor } from "../config.js";
import { errorMessage } from "../errors.js";
import { builtinTools } from "../tools/index.js";
import { formatNumber, oneLine } from "../util/text.js";
import type { ChatRuntime, ChatState } from "./runtime.js";

export interface CommandHost extends ChatRuntime {
  broker: PermissionBroker;
}

export interface CommandSink {
  info(message: string): void;
  error(message: string, hint?: string): void;
}

export const SLASH_HELP = `Commands
  /help              Show this help
  /new               Start a new session (alias: /clear)
  /model [name]      Show or change the model
  /provider [id]     Change the provider (optionally with a model)
  /sessions          List saved sessions for this directory
  /resume [id]       Resume a session (default: most recent)
  /yolo              Toggle auto-approve for the rest of the session
  /usage             Show token usage for this session
  /tools             List available tools
  /exit              Quit (alias: /quit)

Keys
  enter send · ctrl+j newline · ctrl+o expand tool output
  pageup/pagedown scroll · ctrl+c interrupt or clear · ctrl+d quit`;

/**
 * Execute a slash command, mutating `state` in place. Returns true when the
 * caller should exit. Shared by the line REPL and the full-screen TUI.
 */
export async function handleSlashCommand(
  raw: string,
  host: CommandHost,
  state: ChatState,
  sink: CommandSink,
): Promise<boolean> {
  const parts = raw.slice(1).trim().split(/\s+/);
  const command = parts[0] ?? "";
  const argument = parts.slice(1).join(" ");

  switch (command) {
    case "help":
      sink.info(SLASH_HELP);
      return false;

    case "exit":
    case "quit":
      return true;

    case "new":
    case "clear": {
      const next = Session.create({
        cwd: host.cwd,
        provider: state.providerId,
        model: state.model,
      });
      const rebuilt = await host.rebuild({
        session: next,
        providerId: state.providerId,
        model: state.model,
      });
      Object.assign(state, rebuilt);
      sink.info(`Started session ${state.session.id}`);
      return false;
    }

    case "model": {
      if (!argument) {
        sink.info(`Model: ${state.model}`);
        return false;
      }
      try {
        const rebuilt = await host.rebuild({ providerId: state.providerId, model: argument });
        Object.assign(state, rebuilt);
        state.session.model = state.model;
        sink.info(`Model: ${state.model}`);
      } catch (error) {
        sink.error(errorMessage(error));
      }
      return false;
    }

    case "provider": {
      const [nextProvider, nextModel] = argument.split(/\s+/);
      if (!nextProvider) {
        sink.info(`Provider: ${state.providerId} (model: ${state.model})`);
        return false;
      }
      try {
        const rebuilt = await host.rebuild({
          providerId: nextProvider,
          model: nextModel || defaultModelFor(nextProvider) || state.model,
        });
        Object.assign(state, rebuilt);
        state.session.provider = state.providerId;
        state.session.model = state.model;
        sink.info(`Provider: ${state.providerId}/${state.model}`);
      } catch (error) {
        sink.error(errorMessage(error));
      }
      return false;
    }

    case "sessions": {
      const sessions = await host.listSessions();
      if (sessions.length === 0) {
        sink.info("No saved sessions in this directory.");
        return false;
      }
      for (const meta of sessions) {
        const marker = meta.id === state.session.id ? "*" : " ";
        sink.info(
          `${marker} ${meta.id}  ${meta.updatedAt.slice(0, 16).replace("T", " ")}  ${meta.messageCount} msgs  ${oneLine(meta.title, 60)}`,
        );
      }
      return false;
    }

    case "resume": {
      const sessions = await host.listSessions();
      const id = argument || sessions[0]?.id;
      if (!id) {
        sink.info("No session to resume.");
        return false;
      }
      try {
        const loaded = await host.loadSession(id);
        const rebuilt = await host.rebuild({
          session: loaded,
          providerId: loaded.provider || state.providerId,
          model: loaded.model || state.model,
        });
        Object.assign(state, rebuilt);
        sink.info(
          `Resumed ${state.session.id} (${state.session.messages.length} messages, ${oneLine(state.session.title, 50)})`,
        );
      } catch (error) {
        sink.error(errorMessage(error));
      }
      return false;
    }

    case "yolo":
      host.broker.autoApprove = !host.broker.autoApprove;
      sink.info(
        host.broker.autoApprove
          ? "Auto-approve ON: tools run without asking."
          : "Auto-approve OFF.",
      );
      return false;

    case "usage": {
      const usage = state.session.usage;
      sink.info(
        `Tokens: ${formatNumber(usage.inputTokens)} in · ${formatNumber(usage.outputTokens)} out · ${formatNumber(usage.cacheReadTokens)} cached`,
      );
      return false;
    }

    case "tools": {
      for (const tool of builtinTools) {
        sink.info(`${tool.name.padEnd(6)} ${tool.readOnly ? "(read-only)" : ""}`);
      }
      return false;
    }

    default:
      sink.info(`Unknown command /${command}. Try /help.`);
      return false;
  }
}
