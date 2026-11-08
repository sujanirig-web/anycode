import type { PermissionBroker } from "../agent/permissions.js";
import { Session } from "../agent/session.js";
import { deleteProviderPreset, deleteProjectProviderPreset } from "../config.js";
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

export interface CommandItem {
  name: string;
  desc: string;
  args?: string;
}

export const COMMANDS: CommandItem[] = [
  { name: "help", desc: "Show this help" },
  { name: "new", desc: "Start a new session", args: "" },
  { name: "clear", desc: "Start a new session", args: "" },
  { name: "models", desc: "Browse models for the active provider" },
  { name: "connect", desc: "Connect to a provider and configure its API key" },
  { name: "sessions", desc: "List saved sessions" },
  { name: "resume", desc: "Resume a session", args: "" },
  { name: "yolo", desc: "Toggle auto-approve" },
  { name: "usage", desc: "Show token usage" },
  { name: "tools", desc: "List available tools" },
  { name: "mcp", desc: "Show MCP server status" },
  { name: "plugins", desc: "Show loaded plugins", args: "" },
  { name: "delete-provider", desc: "Delete a custom provider", args: "<id>" },
  { name: "exit", desc: "Quit", args: "" },
  { name: "quit", desc: "Quit", args: "" },
];

export const SLASH_HELP = `Commands
  /help              Show this help
  /new               Start a new session
  /models            Browse models for the active provider
  /connect           Choose a provider, enter its API key, and connect
  /sessions          List saved sessions for this directory
  /resume [id]       Resume a session (default: most recent)
  /yolo              Toggle auto-approve for the rest of the session
  /usage             Show token usage for this session
  /tools             List available tools
  /mcp               Show MCP server status
  /plugins [name]    Show loaded plugins (or one plugin's log)
  /delete-provider <id> Delete a custom provider
  /exit              Quit (alias: /quit)

 Keys
  enter send · ctrl+j newline · ctrl+o expand tool output
  pageup/pagedown scroll · end jump to latest · esc quit · ctrl+c interrupt or clear`;

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
      sink.info("Started new session.");
      return false;
    }

    case "models": {
      if (typeof host.showModelPicker === "function") {
        await host.showModelPicker();
        return false;
      }
      sink.error("Model picker is only available in the interactive TUI.");
      return false;
    }

    case "connect": {
      if (typeof host.showProviderPicker === "function") {
        await host.showProviderPicker();
      } else {
        sink.error("/connect is only available in the interactive TUI.");
      }
      return false;
    }

    case "sessions": {
      const sessions = await host.listSessions();
      if (typeof host.showSessionPicker === "function") {
        await host.showSessionPicker();
        return false;
      }
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
          `Resumed session (${state.session.messages.length} messages, ${oneLine(state.session.title, 50)})`,
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
      const external = host.extensionStatus?.().tools ?? [];
      if (external.length > 0) {
        sink.info("External tools:");
        for (const tool of external) {
          sink.info(
            `  ${tool.name.padEnd(6)} ${tool.source}${tool.readOnly ? ", read-only" : ""}`,
          );
        }
      }
      return false;
    }

    case "mcp": {
      const servers = host.extensionStatus?.().mcpServers ?? [];
      if (servers.length === 0) {
        sink.info(
          "No MCP servers configured. Add them to ~/.anycode/mcp.json or .anycode/mcp.json.",
        );
        return false;
      }
      for (const server of servers) {
        const icon = server.status === "ready" ? "✓" : server.status === "disabled" ? "–" : "✗";
        const detail =
          server.status === "ready"
            ? `${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}`
            : server.status;
        sink.info(`${icon} ${server.name} · ${detail}${server.error ? `\n   ${server.error}` : ""}`);
      }
      return false;
    }

    case "plugins": {
      const plugins = host.extensionStatus?.().plugins ?? [];
      if (plugins.length === 0) {
        sink.info(
          "No plugins loaded. Drop .mjs files in ~/.anycode/plugins or .anycode/plugins.",
        );
        return false;
      }
      if (argument) {
        const plugin = plugins.find((entry) => entry.name === argument);
        if (!plugin) {
          sink.error(`No plugin named '${argument}'.`);
          return false;
        }
        const logs = plugin.logs.slice(-20);
        sink.info(`${plugin.name} — ${plugin.path}`);
        for (const line of logs.length > 0 ? logs : ["(no log messages)"]) {
          sink.info(`  ${line}`);
        }
        return false;
      }
      for (const plugin of plugins) {
        const facts = [
          ...(plugin.tools.length > 0 ? [`tools: ${plugin.tools.join(", ")}`] : []),
          ...(plugin.commands.length > 0
            ? [`commands: ${plugin.commands.map((name) => `/${name}`).join(", ")}`]
            : []),
        ];
        sink.info(
          `${plugin.error ? "✗" : "✓"} ${plugin.name}${facts.length > 0 ? ` · ${facts.join(" · ")}` : ""}${plugin.error ? `\n   ${plugin.error}` : ""}`,
        );
      }
      return false;
    }

    case "delete-provider": {
      if (!argument) {
        sink.error("Usage: /delete-provider <id>. Specify the provider ID to delete.");
        return false;
      }
      if (argument === state.providerId) {
        sink.error(
          `Cannot delete the active provider '${argument}'. Switch to another provider first.`,
        );
        return false;
      }
      try {
        const global = await deleteProviderPreset(argument);
        const project = await deleteProjectProviderPreset(argument, host.cwd);
        if (!global.removed && !project.removed) {
          sink.info(`No custom provider preset named '${argument}' was found.`);
          return false;
        }
        const locations = [
          ...(global.removed ? [`global (${global.file})`] : []),
          ...(project.removed ? [`project (${project.file})`] : []),
        ];
        sink.info(`Deleted provider '${argument}' from ${locations.join(" and ")}.`);
      } catch (error) {
        sink.error(errorMessage(error));
      }
      return false;
    }

    default: {
      const plugin = host
        .pluginCommands?.()
        .find((entry) => entry.name === command.toLowerCase());
      if (plugin && host.runPluginCommand) {
        try {
          const message = await host.runPluginCommand(plugin.name, argument, state);
          if (message) sink.info(String(message));
        } catch (error) {
          sink.error(errorMessage(error));
        }
        return false;
      }
      sink.info(`Unknown command /${command}. Try /help.`);
      return false;
    }
  }
}