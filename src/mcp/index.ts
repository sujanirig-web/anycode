import { errorMessage } from "../errors.js";
import type { Tool } from "../tools/types.js";
import { McpClient } from "./client.js";
import { loadMcpConfig, parseMcpServer } from "./config.js";
import { createMcpTool } from "./tool.js";

export interface McpServerStatus {
  name: string;
  status: "ready" | "error" | "disabled";
  toolCount: number;
  error?: string;
}

export interface LoadedMcp {
  servers: McpServerStatus[];
  tools: Tool[];
  clients: McpClient[];
  close(): Promise<void>;
}

function empty(): LoadedMcp {
  return { servers: [], tools: [], clients: [], close: async () => undefined };
}

interface ServerResult {
  status: McpServerStatus;
  tools: Tool[];
  client?: McpClient;
}

async function startServer(name: string, raw: unknown, cwd: string): Promise<ServerResult> {
  const parsed = parseMcpServer(raw);
  if ("error" in parsed) {
    return { status: { name, status: "error", toolCount: 0, error: parsed.error }, tools: [] };
  }
  if (parsed.config.disabled) {
    return { status: { name, status: "disabled", toolCount: 0 }, tools: [] };
  }

  const client = new McpClient(name, parsed.config, cwd);
  try {
    client.start();
    await client.initialize();
    const definitions = await client.listTools();
    return {
      status: { name, status: "ready", toolCount: definitions.length },
      tools: definitions.map((definition) => createMcpTool(client, name, definition)),
      client,
    };
  } catch (error) {
    await client.close().catch(() => undefined);
    return {
      status: { name, status: "error", toolCount: 0, error: errorMessage(error) },
      tools: [],
    };
  }
}

/**
 * Read `mcp.json`, start every enabled server in parallel, and return their
 * tools. Server failures are reported as status entries instead of aborting
 * startup. With no config files this does two failed reads and no spawning.
 */
export async function loadMcpServers(cwd: string): Promise<LoadedMcp> {
  let raw: Record<string, unknown>;
  try {
    raw = await loadMcpConfig(cwd);
  } catch (error) {
    return {
      servers: [{ name: "mcp.json", status: "error", toolCount: 0, error: errorMessage(error) }],
      tools: [],
      clients: [],
      close: async () => undefined,
    };
  }

  const names = Object.keys(raw).sort();
  if (names.length === 0) return empty();

  const results = await Promise.all(names.map((name) => startServer(name, raw[name], cwd)));
  const servers: McpServerStatus[] = [];
  const tools: Tool[] = [];
  const clients: McpClient[] = [];
  const seen = new Set<string>();

  for (const result of results) {
    servers.push(result.status);
    if (result.client) clients.push(result.client);
    for (const tool of result.tools) {
      if (seen.has(tool.name)) continue;
      seen.add(tool.name);
      tools.push(tool);
    }
  }

  return {
    servers,
    tools,
    clients,
    close: async () => {
      await Promise.allSettled(clients.map((client) => client.close()));
    },
  };
}

export { McpClient } from "./client.js";
export type { McpCallResult, McpContentPart, McpToolDefinition } from "./client.js";
export { loadMcpConfig, mcpConfigPaths, parseMcpServer } from "./config.js";
export type { McpServerConfig } from "./config.js";
export { createMcpTool, formatResult, mcpToolName } from "./tool.js";
