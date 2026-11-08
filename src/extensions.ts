import type { AgentEvent } from "./agent/agent.js";
import type { Session } from "./agent/session.js";
import { loadMcpServers, type McpServerStatus } from "./mcp/index.js";
import {
  loadPlugins,
  type PluginCommandContext,
  type PluginStatus,
} from "./plugins/index.js";
import { builtinTools } from "./tools/index.js";
import type { Tool } from "./tools/types.js";

export interface ExtensionToolInfo {
  name: string;
  source: "mcp" | "plugin";
  description: string;
  readOnly: boolean;
}

export interface ExtensionStatus {
  mcpServers: McpServerStatus[];
  plugins: PluginStatus[];
  tools: ExtensionToolInfo[];
}

export interface LoadedExtensions {
  status: ExtensionStatus;
  tools: Tool[];
  /** Extra system-prompt section describing the external tools. */
  prompt?: string;
  /** True when plugins registered hooks; lets the agent skip observer calls. */
  hasHooks: boolean;
  pluginCommands(): Array<{ name: string; desc: string }>;
  runCommand(name: string, args: string, context: Omit<PluginCommandContext, "log">): Promise<string | void>;
  emit(event: AgentEvent, session: Session): Promise<void>;
  close(): Promise<void>;
  /** Last-resort synchronous cleanup for process-exit handlers. */
  disposeSync(): void;
}

function firstLine(text: string, limit = 140): string {
  const line = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function buildPrompt(tools: ExtensionToolInfo[]): string | undefined {
  if (tools.length === 0) return undefined;
  const shown = tools.slice(0, 60).map(
    (tool) =>
      `- ${tool.name}${tool.readOnly ? " (read-only)" : ""}: ${firstLine(tool.description)}`,
  );
  if (tools.length > shown.length) shown.push(`- … ${tools.length - shown.length} more`);

  return [
    "# External tools",
    "These tools come from MCP servers and local plugins. Their descriptions are authoritative; prefer them when they fit the task, and do not assume a tool exists if it is not listed.",
    ...shown,
  ].join("\n");
}

/**
 * Load MCP servers and plugins once per process. Both sources are optional and
 * load in parallel; when nothing is configured this only performs a few failed
 * file reads and spawns no processes.
 */
export async function loadExtensions(cwd: string): Promise<LoadedExtensions> {
  const [mcp, plugins] = await Promise.all([loadMcpServers(cwd), loadPlugins(cwd)]);

  // Built-in and MCP tool names win; a plugin cannot silently shadow them.
  const reserved = new Set([
    ...builtinTools.map((tool) => tool.name),
    ...mcp.tools.map((tool) => tool.name),
  ]);
  const pluginTools: Tool[] = [];
  for (const tool of plugins.tools) {
    if (reserved.has(tool.name)) {
      const owner = plugins.status.find((plugin) => plugin.tools.includes(tool.name));
      owner?.logs.push(
        `tool "${tool.name}" ignored: the name is already used by a built-in or MCP tool`,
      );
      continue;
    }
    pluginTools.push(tool);
  }

  const toolInfo: ExtensionToolInfo[] = [
    ...mcp.tools.map((tool) => ({
      name: tool.name,
      source: "mcp" as const,
      description: tool.description,
      readOnly: tool.readOnly === true,
    })),
    ...pluginTools.map((tool) => ({
      name: tool.name,
      source: "plugin" as const,
      description: tool.description,
      readOnly: tool.readOnly === true,
    })),
  ];

  const prompt = buildPrompt(toolInfo);
  const tools = [...mcp.tools, ...pluginTools];

  return {
    status: {
      mcpServers: mcp.servers,
      plugins: plugins.status,
      tools: toolInfo,
    },
    tools,
    hasHooks: plugins.hasHooks,
    ...(prompt ? { prompt } : {}),
    pluginCommands: () => plugins.commandItems(),
    runCommand: (name, args, context) => plugins.runCommand(name, args, context),
    emit: (event, session) => plugins.emit(event, session),
    close: async () => {
      await Promise.allSettled([mcp.close(), plugins.close()]);
    },
    disposeSync: () => {
      for (const client of mcp.clients) client.killSync();
    },
  };
}
