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