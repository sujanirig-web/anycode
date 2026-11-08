import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { AgentEvent } from "../agent/agent.js";
import type { Session } from "../agent/session.js";
import { homeDir } from "../config.js";
import { errorMessage } from "../errors.js";
import type { Tool } from "../tools/types.js";

export type PluginEventName = "turn_start" | "turn_end" | "tool_start" | "tool_end";

export interface PluginEventPayload {
  event: AgentEvent;
  session: Session;
}

export type PluginEventHandler = (payload: PluginEventPayload) => void | Promise<void>;

export interface PluginCommandContext {
  cwd: string;
  session: Session;
  providerId: string;
  model: string;
  log(message: string): void;
}

export interface PluginCommand {
  /** Command name without the leading slash. */
  name: string;
  description?: string;
  run(
    args: string,
    context: PluginCommandContext,
  ): string | void | Promise<string | void>;
}

export interface PluginApi {
  readonly name: string;
  readonly cwd: string;
  /** Add a tool the model can call. Names must be unique. */
  registerTool(tool: Tool): void;
  /** Add a slash command, e.g. `{ name: "deploy", run: ... }`. */
  registerCommand(command: PluginCommand): void;
  /** Observe agent turns and tool calls. Handler errors are contained. */
  on(event: PluginEventName, handler: PluginEventHandler): void;
  /** Release resources when anycode exits. */
  onCleanup(cleanup: () => void | Promise<void>): void;
  /** Record a line for `/plugins` diagnostics. */
  log(message: string): void;
}

export interface PluginStatus {
  name: string;
  path: string;
  tools: string[];
  commands: string[];
  logs: string[];
  error?: string;
}

export interface PluginCommandInfo {
  name: string;
  desc: string;
}

export interface LoadedPlugins {
  status: PluginStatus[];
  tools: Tool[];
  commands: Map<string, PluginCommand>;
  /** True when at least one plugin registered a hook. */
  hasHooks: boolean;
  /** Fire plugin hooks for an agent event. Never throws. */
  emit(event: AgentEvent, session: Session): Promise<void>;
  /** Run a registered plugin command. */
  runCommand(
    name: string,
    args: string,
    context: Omit<PluginCommandContext, "log">,
  ): Promise<string | void>;
  commandItems(): PluginCommandInfo[];
  close(): Promise<void>;
}

const EVENT_NAMES = new Set<PluginEventName>([
  "turn_start",
  "turn_end",
  "tool_start",
  "tool_end",
]);

const MAX_LOGS = 50;

/** Global plugins load before project plugins. */
export function pluginDirs(cwd: string): string[] {
  return [
    path.join(homeDir(), ".anycode", "plugins"),
    path.join(cwd, ".anycode", "plugins"),
  ];
}

async function listPluginFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter(
      (entry) =>
        entry.isFile() &&
        /\.(mjs|js)$/i.test(entry.name) &&
        !entry.name.startsWith("_") &&
        !entry.name.startsWith("."),
    )
    .map((entry) => path.join(dir, entry.name))
    .sort();
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\//, "").toLowerCase();
}

function validateTool(tool: Tool): void {
  if (tool === null || typeof tool !== "object") {
    throw new Error("registerTool expects a tool object");
  }
  if (typeof tool.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(tool.name)) {
    throw new Error(
      `invalid tool name "${String(tool.name)}" (use 1-64 letters, digits, "_" or "-")`,
    );
  }
  if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
    throw new Error(`tool "${tool.name}" needs a description`);
  }
  if (
    tool.parameters === null ||
    typeof tool.parameters !== "object" ||
    Array.isArray(tool.parameters)
  ) {
    throw new Error(`tool "${tool.name}" needs a JSON schema in "parameters"`);
  }
  if (typeof tool.execute !== "function") {
    throw new Error(`tool "${tool.name}" needs an execute function`);
  }
}

function hookNameFor(event: AgentEvent): PluginEventName | undefined {
  if (event.type === "turn_start") return "turn_start";
  if (event.type === "done") return "turn_end";
  if (event.type === "tool_start") return "tool_start";
  if (event.type === "tool_end") return "tool_end";
  return undefined;
}

function note(status: PluginStatus, message: string): void {
  status.logs.push(message);
  if (status.logs.length > MAX_LOGS) status.logs.shift();
}

/**
 * Discover and load ESM plugins from `~/.anycode/plugins/*.mjs|js` and
 * `<cwd>/.anycode/plugins/*.mjs|js`. A plugin file default-exports a function
 * (or an object with `setup`/`activate`) that receives the plugin API.
 * A failing plugin is reported in the status list and never blocks startup.
 */
export async function loadPlugins(cwd: string): Promise<LoadedPlugins> {
  const files: string[] = [];
  for (const dir of pluginDirs(cwd)) {
    try {
      files.push(...(await listPluginFiles(dir)));
    } catch {
      // An unreadable plugin directory is not fatal.
    }
  }

  const status: PluginStatus[] = [];
  const tools: Tool[] = [];
  const commands = new Map<string, PluginCommand>();
  const owners = new Map<string, PluginStatus>();
  const hooks = new Map<
    PluginEventName,
    Array<{ plugin: PluginStatus; handler: PluginEventHandler }>
  >();
  const cleanups: Array<{ plugin: PluginStatus; run: () => void | Promise<void> }> = [];
  const seenTools = new Set<string>();

  for (const file of files) {
    const fallbackName = path.basename(file).replace(/\.(mjs|js)$/i, "");
    const plugin: PluginStatus = {
      name: fallbackName,
      path: file,
      tools: [],
      commands: [],
      logs: [],
    };

    const api: PluginApi = {
      get name() {
        return plugin.name;
      },
      cwd,
      registerTool(tool) {
        validateTool(tool);
        if (seenTools.has(tool.name)) {
          note(plugin, `tool "${tool.name}" ignored: another plugin already registered it`);
          return;
        }
        seenTools.add(tool.name);
        tools.push(tool);
        plugin.tools.push(tool.name);
      },
      registerCommand(command) {
        const name = normalizeCommandName(command?.name ?? "");
        if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
          throw new Error(
            `invalid command name "${String(command?.name)}" (use letters, digits, "_" or "-")`,
          );
        }
        if (typeof command.run !== "function") {
          throw new Error(`command "/${name}" needs a run function`);
        }
        const normalized: PluginCommand = { ...command, name };
        if (commands.has(name)) note(plugin, `command "/${name}" replaced a previous registration`);
        commands.set(name, normalized);
        owners.set(name, plugin);
        plugin.commands.push(name);
      },
      on(event, handler) {
        if (!EVENT_NAMES.has(event)) {
          throw new Error(
            `unknown hook "${String(event)}" (use ${[...EVENT_NAMES].join(", ")})`,
          );
        }
        if (typeof handler !== "function") throw new Error(`hook "${event}" needs a function`);
        const list = hooks.get(event) ?? [];
        list.push({ plugin, handler });
        hooks.set(event, list);
      },
      onCleanup(cleanup) {
        if (typeof cleanup !== "function") throw new Error("onCleanup needs a function");
        cleanups.push({ plugin, run: cleanup });
      },
      log(message) {
        note(plugin, String(message));
      },
    };

    try {
      const module = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      const exported = module.default ?? module.plugin ?? module;
      const setup =
        typeof exported === "function"
          ? exported
          : exported !== null && typeof exported === "object"
            ? (exported as { setup?: unknown; activate?: unknown }).setup ??
              (exported as { setup?: unknown; activate?: unknown }).activate
            : undefined;
      if (typeof setup !== "function") {
        throw new Error(
          "plugin must default-export a function or export a setup()/activate() function",
        );
      }
      if (typeof module.name === "string" && module.name.trim().length > 0) {
        plugin.name = module.name.trim();
      }
      await (setup as (api: PluginApi) => void | Promise<void>)(api);
    } catch (error) {
      plugin.error = errorMessage(error);
    }

    status.push(plugin);
  }

  return {
    status,
    tools,
    commands,
    hasHooks: hooks.size > 0,

    async emit(event, session) {
      const name = hookNameFor(event);
      if (!name) return;
      const list = hooks.get(name);
      if (!list) return;
      for (const { plugin, handler } of list) {
        try {
          await handler({ event, session });
        } catch (error) {
          note(plugin, `hook ${name} failed: ${errorMessage(error)}`);
        }
      }
    },

    async runCommand(name, args, context) {
      const command = commands.get(normalizeCommandName(name));
      if (!command) throw new Error(`Unknown plugin command /${normalizeCommandName(name)}.`);
      const owner = owners.get(command.name);
      const result = await command.run(args, {
        ...context,
        log: (message: string) => {
          if (owner) note(owner, String(message));
        },
      });
      return result ?? undefined;
    },

    commandItems() {
      return [...commands.values()].map((command) => ({
        name: command.name,
        desc: command.description?.trim() || "Plugin command",
      }));
    },

    async close() {
      for (const cleanup of [...cleanups].reverse()) {
        try {
          await cleanup.run();
        } catch (error) {
          note(cleanup.plugin, `cleanup failed: ${errorMessage(error)}`);
        }
      }
    },
  };
}

/** Empty result used when no plugin directories exist. */
export function emptyPlugins(): LoadedPlugins {
  return {
    status: [],
    tools: [],
    commands: new Map(),
    hasHooks: false,
    emit: async () => undefined,
    runCommand: async () => {
      throw new Error("No plugins are loaded.");
    },
    commandItems: () => [],
    close: async () => undefined,
  };
}
