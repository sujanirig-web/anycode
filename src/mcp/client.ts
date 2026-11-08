import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { NAME, VERSION } from "../version.js";
import type { McpServerConfig } from "./config.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_BUFFER = 2 * 1024 * 1024;

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

/** Allow unref'ing pipe handles, which keeps a stuck server from blocking exit. */
function setHandleRef(handle: unknown, ref: boolean): void {
  const candidate = handle as { ref?: () => void; unref?: () => void } | undefined;
  if (ref) candidate?.ref?.();
  else candidate?.unref?.();
}

/**
 * A minimal MCP client speaking newline-delimited JSON-RPC 2.0 over stdio.
 * Implements the handshake, tool discovery and tool calls; notifications from
 * the server are ignored and unknown server requests are rejected politely.
 */
export class McpClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private stdoutBuffer = "";
  private stderrTail = "";
  private closed = false;
  private started = false;
  private serverCwd: string;

  constructor(
    readonly name: string,
    private readonly config: McpServerConfig,
    private readonly cwd: string,
  ) {
    this.serverCwd = config.cwd ? path.resolve(cwd, config.cwd) : cwd;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  /** Spawn the server process. Does not perform the MCP handshake. */
  start(): void {
    if (this.started) throw new Error(`MCP server "${this.name}" was already started.`);
    this.started = true;

    const command = this.config.command;
    if (!command) throw new Error(`MCP server "${this.name}" is missing "command".`);

    const child = spawn(command, this.config.args ?? [], {
      cwd: this.serverCwd,
      env: { ...process.env, ...(this.config.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      // Windows resolves `npx`/`uvx` through the shell; POSIX does not need it.
      shell: process.platform === "win32",
    });
    this.child = child;

    child.on("error", (error) => {
      this.failAll(
        new Error(`MCP server "${this.name}" failed to start: ${error.message}${this.diagnostics()}`),
      );
    });
    child.on("exit", (code, signal) => {
      if (this.closed) return;
      const detail = signal ? ` (${signal})` : code !== null ? ` with code ${code}` : "";
      this.failAll(
        new Error(`MCP server "${this.name}" exited${detail}.${this.diagnostics()}`),
      );
    });
    child.stdin.on("error", (error) => {
      if (!this.closed) this.failAll(new Error(`MCP server "${this.name}" stdin: ${error.message}`));
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });

    // A long-running server must not keep anycode alive after its turn ends.
    // Handles are re-ref'd while a request is in flight (see setActive).
    child.unref();
    setHandleRef(child.stdin, false);
    setHandleRef(child.stdout, false);
    setHandleRef(child.stderr, false);
  }

  /** Perform the MCP initialize handshake and notify the server we are ready. */
  async initialize(): Promise<Record<string, unknown>> {
    const result = await this.request<Record<string, unknown>>("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { roots: { listChanged: false } },
      clientInfo: { name: NAME, version: VERSION },
    });
    this.notify("notifications/initialized");
    return result ?? {};
  }

  /** List every tool the server exposes, following pagination cursors. */
  async listTools(): Promise<McpToolDefinition[]> {
    const tools: McpToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.request<{ tools?: unknown; nextCursor?: unknown }>(
        "tools/list",
        cursor ? { cursor } : {},
      );
      if (Array.isArray(result?.tools)) {
        for (const tool of result.tools) {
          if (isToolDefinition(tool)) tools.push(tool);
        }
      }
      cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /** Invoke a tool by its server-side name. */
  async callTool(
    tool: string,
    args: Record<string, unknown>,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<McpCallResult> {
    return await this.request<McpCallResult>(
      "tools/call",
      { name: tool, arguments: args },
      options,
    );
  }

  /** Send a JSON-RPC request and wait for the matching response. */
  request<T>(
    method: string,
    params?: unknown,
    options: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<T> {
    if (!this.child || this.closed) {
      return Promise.reject(new Error(`MCP server "${this.name}" is not running.`));
    }

    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const child = this.child;

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const finish = (run: () => void) => {
        if (settled) return;
        settled = true;
        this.pending.delete(id);
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        if (this.pending.size === 0) this.setActive(false);
        run();
      };

      const onAbort = () => {
        finish(() =>
          reject(new Error(`MCP request "${method}" to "${this.name}" was aborted.`)),
        );
        this.notify("notifications/cancelled", { requestId: id, reason: "aborted" });
      };

      timer = setTimeout(() => {
        finish(() =>
          reject(
            new Error(
              `MCP server "${this.name}" did not answer "${method}" within ${timeoutMs}ms.${this.diagnostics()}`,
            ),
          ),
        );
        this.notify("notifications/cancelled", { requestId: id, reason: "timeout" });
      }, timeoutMs);
      timer.unref?.();

      if (options.signal) {
        if (options.signal.aborted) {
          onAbort();
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      this.pending.set(id, {
        resolve: (value) => finish(() => resolve(value as T)),
        reject: (error) => finish(() => reject(error)),
      });
      this.setActive(true);

      try {
        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id,
            method,
            ...(params !== undefined ? { params } : {}),
          })}\n`,
        );
      } catch (error) {
        finish(() =>
          reject(
            new Error(
              `MCP server "${this.name}" is not writable: ${error instanceof Error ? error.message : String(error)}`,
            ),
          ),
        );
      }
    });
  }

  notify(method: string, params?: unknown): void {
    this.write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  /** Stop the server and reject anything still in flight. Idempotent. */
  async close(): Promise<void> {
    this.closed = true;
    this.failAll(new Error(`MCP server "${this.name}" closed.`));
    const child = this.child;
    this.child = undefined;
    if (!child) return;

    try {
      child.stdin.end();
    } catch {
      // The pipe may already be gone.
    }
    if (child.exitCode !== null || child.signalCode !== null) return;

    child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, 2000);
    timer.unref?.();
  }

  /** Best-effort synchronous cleanup for process-exit handlers. */
  killSync(): void {
    this.closed = true;
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    try {
      child.stdin.end();
    } catch {
      // Ignore.
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }

  private write(message: unknown): void {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A dead pipe is reported by the exit/error handlers.
    }
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    if (this.stdoutBuffer.length > MAX_BUFFER) {
      this.stderrTail = `${this.stderrTail}\n[stdout exceeded ${MAX_BUFFER} bytes without a newline]`;
      this.stdoutBuffer = "";
      return;
    }
    let index = this.stdoutBuffer.indexOf("\n");
    while (index >= 0) {
      const line = this.stdoutBuffer.slice(0, index).replace(/\r$/, "");
      this.stdoutBuffer = this.stdoutBuffer.slice(index + 1);
      if (line.trim().length > 0) this.handleLine(line);
      index = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Servers sometimes log to stdout; keep it for diagnostics.
      this.stderrTail = `${this.stderrTail}\n${line}`.slice(-4000);
      return;
    }
    if (parsed === null || typeof parsed !== "object") return;
    const message = parsed as Record<string, unknown>;
    const rawId = message.id;
    const id = typeof rawId === "number" ? rawId : undefined;

    if (id !== undefined && ("result" in message || "error" in message)) {
      const pending = this.pending.get(id);
      if (!pending) return;
      if ("error" in message) {
        pending.reject(new Error(this.formatRpcError(message.error)));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    // Server-initiated requests need an answer; notifications do not.
    if (typeof message.method === "string" && id !== undefined) {
      this.respond(id, message.method);
    }
  }

  private respond(id: number, method: string): void {
    if (method === "ping") {
      this.write({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "roots/list") {
      this.write({
        jsonrpc: "2.0",
        id,
        result: {
          roots: [{ uri: pathToFileURL(this.serverCwd).href, name: path.basename(this.serverCwd) }],
        },
      });
      return;
    }
    this.write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not supported by anycode: ${method}` },
    });
  }

  private formatRpcError(error: unknown): string {
    if (error === null || typeof error !== "object") {
      return `MCP server "${this.name}" returned an error: ${String(error)}`;
    }
    const detail = error as { code?: unknown; message?: unknown; data?: unknown };
    const code = typeof detail.code === "number" ? ` ${detail.code}` : "";
    const message = typeof detail.message === "string" ? detail.message : "unknown error";
    const data = detail.data === undefined ? "" : ` (${JSON.stringify(detail.data)})`;
    return `MCP server "${this.name}" error${code}: ${message}${data}`;
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
    this.setActive(false);
  }

  /** Keep the host alive only while a request is in flight. */
  private setActive(active: boolean): void {
    const child = this.child;
    if (!child) return;
    if (active) child.ref();
    else child.unref();
    setHandleRef(child.stdin, active);
    setHandleRef(child.stdout, active);
    setHandleRef(child.stderr, active);
  }

  private diagnostics(): string {
    const tail = this.stderrTail.trim();
    if (!tail) return "";
    const lines = tail.split(/\r?\n/).slice(-8);
    return `\n${lines.join("\n")}`;
  }
}

export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

export interface McpContentPart {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
  resource?: { uri?: string; text?: string; mimeType?: string };
  [key: string]: unknown;
}

export interface McpCallResult {
  content?: McpContentPart[];
  isError?: boolean;
  structuredContent?: unknown;
  [key: string]: unknown;
}

function isToolDefinition(value: unknown): value is McpToolDefinition {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.name === "string" && candidate.name.length > 0;
}
