/*
┌──────────────────────────────────────────────────────────────────┐
│ test/config.test.ts — config loading, provider defaults, presets   │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { defaultBaseURLFor, defaultModelFor, loadConfig, listProviders, resolveProviderDefaults, saveProviderPreset } from "../src/config.js";
import { createProvider } from "../src/llm/index.js";
import { OpenAIProvider } from "../src/llm/openai.js";

const ENV_KEYS = [
  "ANYCODE_HOME",
  "ANYCODE_PROVIDER",
  "ANYCODE_MODEL",
  "ANYCODE_BASE_URL",
  "ANYCODE_API_KEY",
  "ANYROUTE_API_KEY",
] as const;

const saved = new Map<string, string | undefined>();

function isolateEnv(home: string): void {
  for (const key of ENV_KEYS) {
    if (!saved.has(key)) saved.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.ANYCODE_HOME = home;
}

function restoreEnv(): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
}

const homes: string[] = [];

async function withHome(fn: (home: string, cwd: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(path.join(os.tmpdir(), "anycode-home-"));
  const cwd = await mkdtemp(path.join(os.tmpdir(), "anycode-cwd-"));
  homes.push(home, cwd);
  isolateEnv(home);
  try {
    await fn(home, cwd);
  } finally {
    restoreEnv();
  }
}

after(async () => {
  await Promise.all(homes.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("config", () => {
  it("defaults to the AnyRoute gateway and its 'anyroute' model", async () => {
    await withHome(async (_home, cwd) => {
      const config = await loadConfig(cwd, { provider: "anyroute" });

      assert.equal(config.provider, "anyroute");
      assert.equal(config.model, "anyroute");
      assert.equal(config.baseURL, "http://127.0.0.1:3456/v1");
      assert.equal(config.contextTokens, 1_000_000);
      assert.equal(config.apiKey, undefined);
    });
  });

  it("exposes anyroute helpers for the REPL and CLI", () => {
    assert.equal(defaultModelFor("anyroute"), "anyroute");
    assert.equal(defaultBaseURLFor("anyroute"), "http://127.0.0.1:3456/v1");
    assert.equal(defaultModelFor("unknown-provider"), "");
  });

  it("reads ANYROUTE_API_KEY without requiring one", async () => {
    await withHome(async (_home, cwd) => {
      process.env.ANYROUTE_API_KEY = "test-key";
      const config = await loadConfig(cwd, { provider: "anyroute" });
      assert.equal(config.apiKey, "test-key");
    });
  });

  it("lets .anycode/config.json override the model and base URL", async () => {
    await withHome(async (_home, cwd) => {
      const dir = path.join(cwd, ".anycode");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.json"),
        JSON.stringify({
          provider: "anyroute",
          model: "gemini/gemini-3-flash-preview",
          baseURL: "http://127.0.0.1:9999/v1",
          contextTokens: 1234,
        }),
        "utf8",
      );

      const config = await loadConfig(cwd);
      assert.equal(config.provider, "anyroute");
      assert.equal(config.model, "gemini/gemini-3-flash-preview");
      assert.equal(config.baseURL, "http://127.0.0.1:9999/v1");
      assert.equal(config.contextTokens, 1234);
    });
  });

  it("prefers CLI overrides and environment over config files", async () => {
    await withHome(async (_home, cwd) => {
      process.env.ANYCODE_PROVIDER = "anyroute";
      process.env.ANYCODE_MODEL = "auto";

      const fromEnv = await loadConfig(cwd);
      assert.equal(fromEnv.provider, "anyroute");
      assert.equal(fromEnv.model, "auto");

      const fromCli = await loadConfig(cwd, { model: "free" });
      assert.equal(fromCli.model, "free");
    });
  });

  it("tolerates a UTF-8 BOM in config files", async () => {
    await withHome(async (_home, cwd) => {
      const dir = path.join(cwd, ".anycode");
      await mkdir(dir, { recursive: true });
      await writeFile(
        path.join(dir, "config.json"),
        `\uFEFF${JSON.stringify({ provider: "anyroute", model: "auto" })}`,
        "utf8",
      );

      const config = await loadConfig(cwd);
      assert.equal(config.provider, "anyroute");
      assert.equal(config.model, "auto");
    });
  });
});

describe("anyroute provider", () => {
  it("builds an OpenAI-compatible provider without requiring a key", () => {
    const provider = createProvider({ id: "anyroute", model: "anyroute" });

    assert.ok(provider instanceof OpenAIProvider);
    assert.equal(provider.id, "anyroute");
    assert.equal(provider.label, "AnyRoute");
    assert.equal(provider.requiresApiKey, false);
  });

  it("honours a custom base URL", () => {
    const provider = createProvider({
      id: "anyroute",
      model: "anyroute",
      baseURL: "http://127.0.0.1:9999/v1",
    });
    assert.equal(provider.id, "anyroute");
  });
});

describe("provider presets", () => {
  it("lists all built-in providers", () => {
    const providers = listProviders();
    const ids = providers.map((p) => p.id);
    assert.ok(ids.includes("anthropic"));
    assert.ok(ids.includes("openai"));
    assert.ok(ids.includes("openai-compatible"));
    assert.ok(ids.includes("ollama"));
    assert.ok(ids.includes("anyroute"));
    for (const p of providers) {
      assert.ok(typeof p.model === "string");
      assert.ok(typeof p.site === "string" && p.site.startsWith("http"), `${p.id} should have a site URL`);
    }
    const anthropic = providers.find((p) => p.id === "anthropic");
    assert.equal(anthropic?.site, "https://www.anthropic.com");
    const openai = providers.find((p) => p.id === "openai");
    assert.equal(openai?.site, "https://openai.com");
    const ollama = providers.find((p) => p.id === "ollama");
    assert.equal(ollama?.site, "https://ollama.com");
    const anyroute = providers.find((p) => p.id === "anyroute");
    assert.equal(anyroute?.site, "https://github.com/sujanirig-web/anycode");
  });

  it("resolves built-in defaults without custom presets", () => {
    const defaults = resolveProviderDefaults("anyroute");
    assert.equal(defaults.model, "anyroute");
    assert.equal(defaults.baseURL, "http://127.0.0.1:3456/v1");
    assert.equal(defaults.contextTokens, 1_000_000);
    assert.equal(defaults.site, "https://github.com/sujanirig-web/anycode");
  });

  it("resolves custom project preset overriding built-in", () => {
    const defaults = resolveProviderDefaults("anyroute", undefined, {
      providers: { anyroute: { model: "gemini/custom", baseURL: "http://127.0.0.1:9999/v1" } },
    });
    assert.equal(defaults.model, "gemini/custom");
    assert.equal(defaults.baseURL, "http://127.0.0.1:9999/v1");
    assert.equal(defaults.contextTokens, 1_000_000);
  });

  it("saves and loads a custom provider preset", async () => {
    await withHome(async (home, _cwd) => {
      await saveProviderPreset("my-llm", {
        model: "custom-model",
        baseURL: "http://127.0.0.1:7777/v1",
        keyEnv: "MY_LLM_KEY",
        contextTokens: 500_000,
      });

      const config = await loadConfig(_cwd, { provider: "my-llm" });
      assert.equal(config.provider, "my-llm");
      assert.equal(config.model, "custom-model");
      assert.equal(config.baseURL, "http://127.0.0.1:7777/v1");
      assert.equal(config.contextTokens, 500_000);
    });
  });
});
