/*
┌──────────────────────────────────────────────────────────────────┐
│ test/plugins.test.ts — plugin discovery, tools, commands, hooks   │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, afterEach, beforeEach, describe, it } from "node:test";

import { Session } from "../src/agent/session.js";
import { loadPlugins } from "../src/plugins/index.js";
import { cleanup, tempDir } from "./helpers.js";

const savedHome = process.env.ANYCODE_HOME;
let home = "";

beforeEach(async () => {
  home = await tempDir("anycode-plugin-home-");
  process.env.ANYCODE_HOME = home;
});

afterEach(async () => {
  await cleanup(home);
});

after(() => {
  if (savedHome === undefined) delete process.env.ANYCODE_HOME;
  else process.env.ANYCODE_HOME = savedHome;
});

async function writePlugin(file: string, body: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, body, "utf8");
}

describe("plugins", () => {
  it("loads global and project plugins, tools, commands and hooks", async () => {
    const root = await tempDir("anycode-plugin-cwd-");
    const cleaned = path.join(root, "cleaned.txt");
    try {
      await writePlugin(
        path.join(home, ".anycode", "plugins", "global.mjs"),
        `
export const name = "global-plugin";
export default function (api) {
  api.registerTool({
    name: "hello",
    description: "Say hello from a plugin",
    parameters: { type: "object", properties: {} },
    readOnly: true,
    async execute() { return "hello from plugin"; },
  });
  api.registerCommand({
    name: "greet",
    description: "Greet someone",
    run(args, context) {
      context.log("greet ran");
      return "hello " + args;
    },
  });
  api.on("turn_start", ({ event }) => api.log("turn " + event.step));
  api.on("tool_end", () => { throw new Error("hook boom"); });
  api.onCleanup(async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(${JSON.stringify(cleaned)}, "cleaned");
  });
}
`,
      );

      await writePlugin(
        path.join(root, ".anycode", "plugins", "project.mjs"),
        `
export default function (api) {
  api.registerTool({
    name: "hello",
    description: "Duplicate name",
    parameters: { type: "object", properties: {} },
    async execute() { return "nope"; },
  });
  api.registerCommand({ name: "project", run() { return "project ok"; } });
}
`,
      );

      const loaded = await loadPlugins(root);
      try {
        assert.equal(loaded.status.length, 2);
        const names = loaded.status.map((plugin) => plugin.name).sort();
        assert.deepEqual(names, ["global-plugin", "project"]);

        // The duplicate tool is ignored and noted.
        assert.deepEqual(loaded.tools.map((tool) => tool.name), ["hello"]);
        assert.ok(
          loaded.status
            .find((plugin) => plugin.name === "project")
            ?.logs.some((line) => /already registered/.test(line)),
        );

        assert.deepEqual(
          loaded.commandItems().map((command) => command.name).sort(),
          ["greet", "project"],
        );

        const session = Session.create({ cwd: root, provider: "test", model: "test" });
        const context = { cwd: root, session, providerId: "test", model: "test" };
        assert.equal(await loaded.runCommand("greet", "bob", context), "hello bob");
        assert.equal(await loaded.runCommand("project", "", context), "project ok");

        const global = loaded.status.find((plugin) => plugin.name === "global-plugin");
        assert.ok(global?.logs.includes("greet ran"));

        // Hook errors are contained and recorded.
        await loaded.emit({ type: "turn_start", step: 1 }, session);
        await loaded.emit({ type: "tool_end", call: { id: "1", name: "hello", arguments: "{}" }, content: "ok", isError: false, durationMs: 1 }, session);
        assert.ok(global?.logs.includes("turn 1"));
        assert.ok(global?.logs.some((line) => /hook tool_end failed: hook boom/.test(line)));

        const tool = loaded.tools[0];
        assert.ok(tool);
        assert.equal(
          await tool.execute({}, { cwd: root, approve: async () => true }),
          "hello from plugin",
        );
      } finally {
        await loaded.close();
      }

      await assert.doesNotReject(() => access(cleaned));
    } finally {
      await cleanup(root);
    }
  });

  it("isolates a failing plugin and keeps the others", async () => {
    const root = await tempDir("anycode-plugin-broken-");
    try {
      await writePlugin(
        path.join(root, ".anycode", "plugins", "broken.mjs"),
        `throw new Error("boom");`,
      );
      await writePlugin(
        path.join(root, ".anycode", "plugins", "good.mjs"),
        `export default function (api) {
  api.registerCommand({ name: "good", run() { return "ok"; } });
}`,
      );

      const loaded = await loadPlugins(root);
      try {
        const broken = loaded.status.find((plugin) => plugin.name === "broken");
        assert.match(broken?.error ?? "", /boom/);
        const good = loaded.status.find((plugin) => plugin.name === "good");
        assert.equal(good?.error, undefined);
        assert.ok(loaded.commands.has("good"));
      } finally {
        await loaded.close();
      }
    } finally {
      await cleanup(root);
    }
  });

  it("ignores unknown hook names and invalid tools", async () => {
    const root = await tempDir("anycode-plugin-invalid-");
    try {
      await writePlugin(
        path.join(root, ".anycode", "plugins", "invalid.mjs"),
        `export default function (api) {
  api.on("nope", () => {});
  api.registerTool({ name: "bad name", description: "x", parameters: {}, execute() {} });
}`,
      );
      const loaded = await loadPlugins(root);
      try {
        assert.match(loaded.status[0]?.error ?? "", /unknown hook/);
        assert.equal(loaded.tools.length, 0);
      } finally {
        await loaded.close();
      }
    } finally {
      await cleanup(root);
    }
  });

  it("is a no-op when no plugin directories exist", async () => {
    const root = await tempDir("anycode-plugin-empty-");
    try {
      const loaded = await loadPlugins(root);
      assert.deepEqual(loaded.status, []);
      assert.deepEqual(loaded.tools, []);
      assert.deepEqual(loaded.commandItems(), []);
      await loaded.close();
    } finally {
      await cleanup(root);
    }
  });
});
