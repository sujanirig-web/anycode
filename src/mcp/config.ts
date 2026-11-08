import { promises as fs } from "node:fs";
import path from "node:path";

import { homeDir } from "../config.js";

/** A single stdio MCP server entry from `mcp.json`. */
export interface McpServerConfig {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for the server process, relative to the project. */
  cwd?: string;
  disabled?: boolean;
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number;
}

export interface McpConfigPaths {
  global: string;
  project: string;
}

export function mcpConfigPaths(cwd: string): McpConfigPaths {
  return {
    global: path.join(homeDir(), ".anycode", "mcp.json"),
    project: path.join(cwd, ".anycode", "mcp.json"),
  };
}

async function readJsonObject(file: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid MCP config at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function serverEntries(file: string, data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {};
  const servers = data.mcpServers ?? data.servers;
  if (servers === undefined) return {};
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    throw new Error(`Invalid MCP config at ${file}: "mcpServers" must be an object.`);
  }
  return servers as Record<string, unknown>;
}

/**
 * Merge `~/.anycode/mcp.json` with `<cwd>/.anycode/mcp.json`.
 * Project entries replace global entries with the same server name.
 * Returns raw entries; `parseMcpServer` validates each one.
 */
export async function loadMcpConfig(cwd: string): Promise<Record<string, unknown>> {
  const paths = mcpConfigPaths(cwd);
  const [global, project] = await Promise.all([
    readJsonObject(paths.global),
    readJsonObject(paths.project),
  ]);
  return {
    ...serverEntries(paths.global, global),
    ...serverEntries(paths.project, project),
  };
}

export type ParsedMcpServer =
  | { config: McpServerConfig }
  | { error: string };

/** Validate a raw `mcpServers.<name>` entry. */
export function parseMcpServer(raw: unknown): ParsedMcpServer {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: "expected an object" };
  }
  const entry = raw as Record<string, unknown>;

  const disabled = entry.disabled === true;
  const command = typeof entry.command === "string" ? entry.command.trim() : undefined;
  if (!disabled && !command) return { error: 'missing "command"' };

  const config: McpServerConfig = {};
  if (command) config.command = command;
  if (disabled) config.disabled = true;

  if (entry.args !== undefined) {
    if (!Array.isArray(entry.args) || entry.args.some((arg) => typeof arg !== "string")) {
      return { error: '"args" must be an array of strings' };
    }
    config.args = [...entry.args];
  }

  if (entry.env !== undefined) {
    if (entry.env === null || typeof entry.env !== "object" || Array.isArray(entry.env)) {
      return { error: '"env" must be an object' };
    }
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(entry.env as Record<string, unknown>)) {
      if (typeof value === "string") env[key] = value;
      else if (typeof value === "number" || typeof value === "boolean") env[key] = String(value);
    }
    config.env = env;
  }

  if (typeof entry.cwd === "string" && entry.cwd.length > 0) config.cwd = entry.cwd;
  if (typeof entry.timeoutMs === "number" && Number.isFinite(entry.timeoutMs) && entry.timeoutMs > 0) {
    config.timeoutMs = entry.timeoutMs;
  }

  return { config };
}
