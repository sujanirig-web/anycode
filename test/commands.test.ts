import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { COMMANDS, handleSlashCommand, SLASH_HELP, type CommandHost, type CommandSink } from "../src/ui/commands.js";
import type { ChatState } from "../src/ui/runtime.js";

describe("provider picker commands", () => {
  it("advertises /connect instead of the old provider commands", () => {
    const names = COMMANDS.map((command) => command.name);
    assert.ok(names.includes("connect"));
    assert.ok(names.includes("models"));
    assert.ok(!names.includes("model"));
    assert.ok(!names.includes("provider"));
    assert.ok(!names.includes("providers"));
    assert.match(SLASH_HELP, /\/connect/);
    assert.match(SLASH_HELP, /\/models/);
    assert.doesNotMatch(SLASH_HELP, /\/model\s/);
    assert.doesNotMatch(SLASH_HELP, /\/providers?/);
  });

  it("routes /connect to the provider picker", async () => {
    const calls: string[] = [];
    const host = {
      showProviderPicker: async () => {
        calls.push("picker");
      },
    } as unknown as CommandHost;
    const state = {} as ChatState;
    const sink: CommandSink = { info: () => undefined, error: () => undefined };

    await handleSlashCommand("/connect", host, state, sink);

    assert.deepEqual(calls, ["picker"]);
  });

  it("routes /sessions to the interactive picker when available", async () => {
    const calls: string[] = [];
    const host = {
      listSessions: async () => [],
      showSessionPicker: async () => {
        calls.push("picker");
      },
    } as unknown as CommandHost;
    const state = {} as ChatState;
    const sink: CommandSink = { info: () => undefined, error: () => undefined };

    await handleSlashCommand("/sessions", host, state, sink);

    assert.deepEqual(calls, ["picker"]);
  });

  it("refuses to delete the active provider", async () => {
    const errors: string[] = [];
    const host = {} as CommandHost;
    const state = { providerId: "my-llm" } as ChatState;
    const sink: CommandSink = {
      info: () => undefined,
      error: (message) => errors.push(message),
    };

    await handleSlashCommand("/delete-provider my-llm", host, state, sink);

    assert.match(errors[0] ?? "", /active provider/);
  });
});

describe("extension commands", () => {
  it("lists MCP servers and their tool counts", async () => {
    const info: string[] = [];
    const host = {
      extensionStatus: () => ({
        mcpServers: [
          { name: "github", status: "ready", toolCount: 2 },
          { name: "off", status: "disabled", toolCount: 0 },
          { name: "bad", status: "error", toolCount: 0, error: "boom" },
        ],
        plugins: [],
        tools: [],
      }),
    } as unknown as CommandHost;
    const sink: CommandSink = {
      info: (message) => info.push(message),
      error: () => undefined,
    };

    await handleSlashCommand("/mcp", host, {} as ChatState, sink);
    const text = info.join("\n");
    assert.match(text, /github · 2 tools/);
    assert.match(text, /off · disabled/);
    assert.match(text, /bad · error/);
    assert.match(text, /boom/);
  });

  it("explains how to configure MCP when nothing is loaded", async () => {
    const info: string[] = [];
    const host = { extensionStatus: () => ({ mcpServers: [], plugins: [], tools: [] }) } as unknown as CommandHost;
    const sink: CommandSink = { info: (message) => info.push(message), error: () => undefined };

    await handleSlashCommand("/mcp", host, {} as ChatState, sink);

    assert.match(info[0] ?? "", /No MCP servers configured/);
  });

  it("lists plugins and their registrations", async () => {
    const info: string[] = [];
    const host = {
      extensionStatus: () => ({
        mcpServers: [],
        plugins: [
          {
            name: "deploy",
            path: "/tmp/deploy.mjs",
            tools: ["ship"],
            commands: ["deploy"],
            logs: [],
          },
        ],
        tools: [{ name: "ship", source: "plugin" as const, description: "Ship", readOnly: false }],
      }),
    } as unknown as CommandHost;
    const sink: CommandSink = { info: (message) => info.push(message), error: () => undefined };

    await handleSlashCommand("/plugins", host, {} as ChatState, sink);
    const text = info.join("\n");
    assert.match(text, /deploy/);
    assert.match(text, /tools: ship/);
    assert.match(text, /commands: \/deploy/);
  });

  it("dispatches plugin slash commands with their arguments", async () => {
    const calls: Array<{ name: string; args: string }> = [];
    const host = {
      pluginCommands: () => [{ name: "deploy", desc: "Deploy" }],
      runPluginCommand: async (name: string, args: string) => {
        calls.push({ name, args });
        return `deployed ${args}`;
      },
    } as unknown as CommandHost;
    const info: string[] = [];
    const sink: CommandSink = { info: (message) => info.push(message), error: () => undefined };

    await handleSlashCommand("/deploy staging", host, {} as ChatState, sink);

    assert.deepEqual(calls, [{ name: "deploy", args: "staging" }]);
    assert.equal(info[0], "deployed staging");
  });
});