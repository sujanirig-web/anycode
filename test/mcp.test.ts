/*
┌──────────────────────────────────────────────────────────────────┐
│ test/mcp.test.ts — MCP config, JSON-RPC client, tool adapter      │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { ToolError } from "../src/errors.js";
import {
  McpClient,
  createMcpTool,
  formatResult,
  loadMcpConfig,
  loadMcpServers,
  mcpToolName,
  parseMcpServer,
} from "../src/mcp/index.js";
import type { ToolContext } from "../src/tools/types.js";
import { cleanup, tempDir } from "./helpers.js";

const savedHome = process.env.ANYCODE_HOME;
let home = "";

beforeEach(async () => {
  home = await tempDir("anycode-mcp-home-");
  process.env.ANYCODE_HOME = home;
});

afterEach(async () => {
  await cleanup(home);
});

after(() => {
  if (savedHome === undefined) delete process.env.ANYCODE_HOME;
  else process.env.ANYCODE_HOME = savedHome;
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const FAKE_SERVER = `
import { createInterface } from "node:readline";

const rl = createInterface({ input: process.stdin });

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    send({
      id: message.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake", version: "1.0.0" },
      },
    });
    // An unsolicited notification must be ignored by the client.
    send({ method: "notifications/message", params: { level: "info", data: "hi" } });
    return;
  }
  if (message.method === "tools/list") {
    if (!message.params || !message.params.cursor) {
      send({
        id: message.id,
        result: {
          tools: [
            {
              name: "echo",
              description: "Echo text back",
              inputSchema: {
                type: "object",
                properties: { text: { type: "string" } },
                required: ["text"],
              },
            },
          ],
          nextCursor: "page-2",
        },
      });
    } else {
      send({
        id: message.id,
        result: {
          tools: [
            {
              name: "fail",
              description: "Always fails",
              annotations: { readOnlyHint: true },
            },
          ],
        },
      });
    }
    return;
  }
  if (message.method === "tools/call") {
    if (message.params.name === "fail") {
      send({
        id: message.id,
        result: { content: [{ type: "text", text: "boom" }], isError: true },
      });
    } else {
      send({
        id: message.id,
        result: { content: [{ type: "text", text: "echo:" + message.params.arguments.text }] },
      });
    }
    return;
  }
  if (message.method === "ping") {
    send({ id: message.id, result: {} });
    return;
  }
  if (message.id !== undefined) {
    send({ id: message.id, error: { code: -32601, message: "unknown method" } });
  }
});

rl.on("close", () => process.exit(0));
`;

async function writeFakeServer(root: string): Promise<string> {
  const file = path.join(root, "fake-mcp-server.mjs");
  await writeFile(file, FAKE_SERVER, "utf8");
  return file;
}

describe("mcp config", () => {
  it("merges global and project servers with project precedence", async () => {
    const root = await tempDir("anycode-mcp-cwd-");
    try {
      await writeJson(path.join(home, ".anycode", "mcp.json"), {
        mcpServers: {
          shared: { command: "global-cmd" },
          globalOnly: { command: "g" },
        },
      });
      await writeJson(path.join(root, ".anycode", "mcp.json"), {
        mcpServers: {
          shared: { command: "project-cmd", args: ["--x"] },
          projectOnly: { command: "p", disabled: true },
        },
      });

      const merged = await loadMcpConfig(root);
      assert.deepEqual(Object.keys(merged).sort(), ["globalOnly", "projectOnly", "shared"]);
      assert.deepEqual(merged.shared, { command: "project-cmd", args: ["--x"] });
    } finally {
      await cleanup(root);
    }
  });

  it("returns an empty map when no config exists", async () => {
    const root = await tempDir("anycode-mcp-empty-");
    try {
      assert.deepEqual(await loadMcpConfig(root), {});
    } finally {
      await cleanup(root);
    }
  });

  it("validates server entries", () => {
    assert.match(
      (parseMcpServer({}) as { error: string }).error,
      /missing "command"/,
    );
    assert.match(
      (parseMcpServer({ command: "x", args: "nope" }) as { error: string }).error,
      /args/,
    );
    const parsed = parseMcpServer({
      command: " node ",
      args: ["a"],
      env: { TOKEN: 123, FLAG: true },
      cwd: "sub",
      timeoutMs: 5000,
    });
    assert.deepEqual(parsed, {
      config: {
        command: "node",
        args: ["a"],
        env: { TOKEN: "123", FLAG: "true" },
        cwd: "sub",
        timeoutMs: 5000,
      },
    });
    assert.deepEqual(parseMcpServer({ disabled: true }), { config: { disabled: true } });
  });
});

describe("mcp tool adapter", () => {
  it("builds provider-safe names", () => {
    assert.equal(mcpToolName("my server", "do.thing"), "mcp__my_server__do_thing");
    assert.equal(mcpToolName("github", "search_repos"), "mcp__github__search_repos");
  });

  it("flattens content parts", () => {
    assert.equal(
      formatResult({
        content: [
          { type: "text", text: "one" },
          { type: "image", mimeType: "image/png", data: "abc" },
          { type: "resource", resource: { uri: "file:///x" } },
        ],
      }),
      "one\n[image image/png, 3 base64 chars]\n[resource file:///x]",
    );
    assert.equal(formatResult({ structuredContent: { ok: true } }), '{\n  "ok": true\n}');
    assert.equal(formatResult(undefined), "");
  });

  it("calls the client and skips approval for read-only tools", async () => {
    const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
    const client = {
      callTool: async (tool: string, args: Record<string, unknown>) => {
        calls.push({ tool, args });
        return { content: [{ type: "text", text: "ok" }] };
      },
    } as unknown as McpClient;

    const tool = createMcpTool(client, "srv", {
      name: "echo",
      description: "Echo",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
    });
    assert.equal(tool.name, "mcp__srv__echo");
    assert.equal(tool.readOnly, true);

    let approvals = 0;
    const ctx: ToolContext = {
      cwd: "/tmp",
      approve: async () => {
        approvals++;
        return true;
      },
    };
    assert.equal(await tool.execute({ text: "hi" }, ctx), "ok");
    assert.equal(approvals, 0);
    assert.deepEqual(calls, [{ tool: "echo", args: { text: "hi" } }]);
  });

  it("asks before calling a mutating tool and honours denial", async () => {
    const client = { callTool: async () => ({ content: [] }) } as unknown as McpClient;
    const tool = createMcpTool(client, "srv", { name: "write", description: "Write" });

    const requests: string[] = [];
    const denied: ToolContext = {
      cwd: "/tmp",
      approve: async (request) => {
        requests.push(`${request.kind}:${request.tool}`);
        return false;
      },
    };
    await assert.rejects(() => tool.execute({ a: 1 }, denied), ToolError);
    assert.deepEqual(requests, ["mcp:mcp__srv__write"]);

    const allowed: ToolContext = { cwd: "/tmp", approve: async () => true };
    assert.equal(await tool.execute({}, allowed), "(no output)");
  });

  it("turns MCP isError results into ToolError", async () => {
    const client = {
      callTool: async () => ({ content: [{ type: "text", text: "boom" }], isError: true }),
    } as unknown as McpClient;
    const tool = createMcpTool(client, "srv", { name: "fail", description: "Fail" });
    await assert.rejects(
      () => tool.execute({}, { cwd: "/tmp", approve: async () => true }),
      /boom/,
    );
  });
});

describe("mcp client", () => {
  it("handshakes, paginates tools, and calls them", async () => {
    const root = await tempDir("anycode-mcp-client-");
    try {
      const script = await writeFakeServer(root);
      const client = new McpClient(
        "fake",
        { command: process.execPath, args: [script] },
        root,
      );
      client.start();
      try {
        const info = await client.initialize();
        assert.equal((info.serverInfo as { name?: string }).name, "fake");

        const tools = await client.listTools();
        assert.deepEqual(tools.map((tool) => tool.name), ["echo", "fail"]);

        const result = await client.callTool("echo", { text: "hello" });
        assert.equal(result.content?.[0]?.text, "echo:hello");
      } finally {
        await client.close();
      }
    } finally {
      await cleanup(root);
    }
  });

  it("reports a request timeout", async () => {
    const root = await tempDir("anycode-mcp-timeout-");
    try {
      const script = path.join(root, "silent.mjs");
      await writeFile(script, "process.stdin.resume();\n", "utf8");
      const client = new McpClient(
        "silent",
        { command: process.execPath, args: [script], timeoutMs: 200 },
        root,
      );
      client.start();
      try {
        await assert.rejects(() => client.initialize(), /did not answer/);
      } finally {
        await client.close();
      }
    } finally {
      await cleanup(root);
    }
  });
});

describe("mcp loading", () => {
  it("loads configured servers and namespaces their tools", async () => {
    const root = await tempDir("anycode-mcp-load-");
    try {
      const script = await writeFakeServer(root);
      await writeJson(path.join(root, ".anycode", "mcp.json"), {
        mcpServers: {
          fake: { command: process.execPath, args: [script] },
          broken: { command: process.execPath, args: [path.join(root, "missing.mjs")] },
          off: { command: "true", disabled: true },
        },
      });

      const loaded = await loadMcpServers(root);
      try {
        const statuses = Object.fromEntries(loaded.servers.map((s) => [s.name, s]));
        assert.equal(statuses.fake?.status, "ready");
        assert.equal(statuses.fake?.toolCount, 2);
        assert.equal(statuses.off?.status, "disabled");
        assert.equal(statuses.broken?.status, "error");

        const names = loaded.tools.map((tool) => tool.name).sort();
        assert.deepEqual(names, ["mcp__fake__echo", "mcp__fake__fail"]);

        const echo = loaded.tools.find((tool) => tool.name === "mcp__fake__echo");
        assert.ok(echo);
        assert.equal(
          await echo.execute({ text: "x" }, { cwd: root, approve: async () => true }),
          "echo:x",
        );
      } finally {
        await loaded.close();
      }
    } finally {
      await cleanup(root);
    }
  });

  it("reports invalid JSON without throwing", async () => {
    const root = await tempDir("anycode-mcp-bad-");
    try {
      const file = path.join(root, ".anycode", "mcp.json");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, "{ not json", "utf8");
      const loaded = await loadMcpServers(root);
      assert.equal(loaded.servers[0]?.status, "error");
      assert.match(loaded.servers[0]?.error ?? "", /Invalid MCP config/);
      assert.equal(loaded.tools.length, 0);
      await loaded.close();
      assert.equal(await readFile(file, "utf8"), "{ not json");
    } finally {
      await cleanup(root);
    }
  });
});
