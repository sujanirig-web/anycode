import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Config {
  provider: string;
  model: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens: number;
  temperature?: number;
  maxSteps: number;
  contextTokens: number;
  autoApprove: boolean;
}

export const PROVIDER_IDS = [
  "anyroute",
  "anthropic",
  "openai",
  "openai-compatible",
  "nvidia-nim",
  "mistral",
  "google-gemini",
  "deepseek",
  "groq",
  "openrouter",
  "together",
  "fireworks",
  "cerebras",
  "xai",
  "cohere",
  "sambanova",
  "perplexity",
  "ollama",
] as const;

export function homeDir(): string {
  return process.env.ANYCODE_HOME ?? os.homedir();
}

export interface ProviderInfo {
  id: string;
  model: string;
  baseURL?: string;
  keyEnv?: string;
  contextTokens?: number;
  site?: string;
}

export function listProviders(): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => {
    const defaults = PROVIDER_DEFAULTS[id];
    return {
      id,
      model: defaults?.model ?? "",
      baseURL: defaults?.baseURL,
      keyEnv: defaults?.keyEnv,
      contextTokens: defaults?.contextTokens,
      site: defaults?.site,
    };
  });
}

export function configPaths(cwd: string): { global: string; project: string } {
  return {
    global: path.join(homeDir(), ".anycode", "config.json"),
    project: path.join(cwd, ".anycode", "config.json"),
  };
}

interface ProviderDefaults {
  model: string;
  keyEnv?: string;
  baseURL?: string;
  contextTokens?: number;
  site?: string;
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  anthropic: { model: "claude-sonnet-4-5", keyEnv: "ANTHROPIC_API_KEY", site: "https://www.anthropic.com" },
  openai: { model: "gpt-4.1", keyEnv: "OPENAI_API_KEY", site: "https://openai.com" },
  "openai-compatible": { model: "", keyEnv: "OPENAI_API_KEY", site: "https://platform.openai.com" },
  "nvidia-nim": {
    model: "meta/llama-3.1-8b-instruct",
    keyEnv: "NVIDIA_API_KEY",
    baseURL: "https://integrate.api.nvidia.com/v1",
    site: "https://build.nvidia.com",
  },
  mistral: {
    model: "mistral-large-latest",
    keyEnv: "MISTRAL_API_KEY",
    baseURL: "https://api.mistral.ai/v1",
    site: "https://mistral.ai",
  },
  "google-gemini": {
    model: "gemini-2.5-flash",
    keyEnv: "GEMINI_API_KEY",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    site: "https://ai.google.dev",
  },
  deepseek: {
    model: "deepseek-chat",
    keyEnv: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1",
    site: "https://www.deepseek.com",
  },
  groq: {
    model: "llama-3.3-70b-versatile",
    keyEnv: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1",
    site: "https://groq.com",
  },
  openrouter: {
    model: "openai/gpt-4.1-mini",
    keyEnv: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    site: "https://openrouter.ai",
  },
  together: {
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    keyEnv: "TOGETHER_API_KEY",
    baseURL: "https://api.together.xyz/v1",
    site: "https://www.together.ai",
  },
  fireworks: {
    model: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    keyEnv: "FIREWORKS_API_KEY",
    baseURL: "https://api.fireworks.ai/inference/v1",
    site: "https://fireworks.ai",
  },
  cerebras: {
    model: "llama-3.3-70b",
    keyEnv: "CEREBRAS_API_KEY",
    baseURL: "https://api.cerebras.ai/v1",
    site: "https://cerebras.ai",
  },
  xai: {
    model: "grok-3-mini",
    keyEnv: "XAI_API_KEY",
    baseURL: "https://api.x.ai/v1",
    site: "https://x.ai",
  },
  cohere: {
    model: "command-a-03-2025",
    keyEnv: "COHERE_API_KEY",
    baseURL: "https://api.cohere.com/compatibility/v1",
    site: "https://cohere.com",
  },
  sambanova: {
    model: "Meta-Llama-3.3-70B-Instruct",
    keyEnv: "SAMBANOVA_API_KEY",
    baseURL: "https://api.sambanova.ai/v1",
    site: "https://sambanova.ai",
  },
  perplexity: {
    model: "sonar-pro",
    keyEnv: "PERPLEXITY_API_KEY",
    baseURL: "https://api.perplexity.ai",
    site: "https://perplexity.ai",
  },
  ollama: {
    model: "qwen2.5-coder",
    keyEnv: undefined,
    baseURL: "http://localhost:11434/v1",
    site: "https://ollama.com",
  },
  anyroute: {
    model: "anyroute",
    keyEnv: "ANYROUTE_API_KEY",
    baseURL: "http://127.0.0.1:3456/v1",
    contextTokens: 1_000_000,
    site: "https://github.com/sujanirig-web/anycode",
  },
};

export function defaultModelFor(provider: string): string {
  return PROVIDER_DEFAULTS[provider]?.model ?? "";
}

export function defaultBaseURLFor(provider: string): string | undefined {
  if (provider === "anthropic") return "https://api.anthropic.com/v1";
  if (provider === "openai") return "https://api.openai.com/v1";
  return PROVIDER_DEFAULTS[provider]?.baseURL;
}

/**
 * Merge built-in provider defaults with any custom preset saved in the config
 * layers (global then project). Custom presets can override built-ins.
 */
export function resolveProviderDefaults(
  provider: string,
  global?: Record<string, unknown>,
  project?: Record<string, unknown>,
): ProviderDefaults {
  const builtIn = PROVIDER_DEFAULTS[provider] ?? {};
  const customGlobal = (global?.providers as Record<string, unknown> ?? {})[provider];
  const customProject = (project?.providers as Record<string, unknown> ?? {})[provider];
  return {
    ...builtIn,
    ...(typeof customGlobal === "object" && customGlobal !== null ? customGlobal : {}),
    ...(typeof customProject === "object" && customProject !== null ? customProject : {}),
  } as ProviderDefaults;
}

export async function listConfiguredProviders(cwd: string): Promise<ProviderInfo[]> {
  const paths = configPaths(cwd);
  const [global, project] = await Promise.all([
    readJsonFile(paths.global),
    readJsonFile(paths.project),
  ]);
  const globalProviders = global?.providers as Record<string, unknown> | undefined;
  const projectProviders = project?.providers as Record<string, unknown> | undefined;
  const ids = [...new Set([
    ...PROVIDER_IDS,
    ...Object.keys(globalProviders ?? {}),
    ...Object.keys(projectProviders ?? {}),
  ])];

  return ids.map((id) => {
    const defaults = resolveProviderDefaults(id, global, project);
    const baseURL = defaults.baseURL ?? defaultBaseURLFor(id);
    return {
      id,
      model: defaults.model ?? "",
      ...(baseURL ? { baseURL } : {}),
      ...(defaults.keyEnv ? { keyEnv: defaults.keyEnv } : {}),
      ...(defaults.contextTokens ? { contextTokens: defaults.contextTokens } : {}),
      ...(defaults.site ? { site: defaults.site } : {}),
    };
  });
}

async function readJsonFile(file: string): Promise<Record<string, unknown> | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  // Editors on Windows (PowerShell, Notepad) may prepend a UTF-8 BOM.
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error(
      `Invalid config at ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function pickString(
  layer: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = layer?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pickNumber(
  layer: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = layer?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function pickBoolean(
  layer: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = layer?.[key];
  return typeof value === "boolean" ? value : undefined;
}

export interface ConfigOverrides {
  provider?: string;
  model?: string;
  baseURL?: string;
  apiKey?: string;
  maxTokens?: number;
  temperature?: number;
  maxSteps?: number;
  contextTokens?: number;
  autoApprove?: boolean;
}

/**
 * Merge defaults, `~/.anycode/config.json`, `<cwd>/.anycode/config.json`,
 * environment variables, then CLI overrides (highest priority).
 */
export async function loadConfig(
  cwd: string,
  overrides: ConfigOverrides = {},
): Promise<Config> {
  const paths = configPaths(cwd);
  const global = await readJsonFile(paths.global);
  const project = await readJsonFile(paths.project);
  const env = process.env;

  const provider =
    overrides.provider ??
    env.ANYCODE_PROVIDER ??
    pickString(project, "provider") ??
    pickString(global, "provider") ??
    "anthropic";

  const defaults = resolveProviderDefaults(provider, global, project);

  const model =
    overrides.model ??
    env.ANYCODE_MODEL ??
    pickString(project, "model") ??
    pickString(global, "model") ??
    defaults.model;

  const baseURL =
    overrides.baseURL ??
    env.ANYCODE_BASE_URL ??
    pickString(project, "baseURL") ??
    pickString(global, "baseURL") ??
    defaults.baseURL;

  const keyEnv = defaults.keyEnv;
  const apiKey =
    overrides.apiKey ??
    env.ANYCODE_API_KEY ??
    (keyEnv ? env[keyEnv] : undefined) ??
    pickString(project, "apiKey") ??
    pickString(global, "apiKey");

  // `autoApprove` defaults to `true` so normal startup can write files and run
  // commands without the `--yolo` flag. An explicit `false` in a config layer
  // (or `--ask` on the CLI) still requires permission prompts.
  const projectAutoApprove = pickBoolean(project, "autoApprove");
  const globalAutoApprove = pickBoolean(global, "autoApprove");

  return {
    provider,
    model,
    ...(baseURL ? { baseURL } : {}),
    ...(apiKey ? { apiKey } : {}),
    maxTokens:
      overrides.maxTokens ??
      pickNumber(project, "maxTokens") ??
      pickNumber(global, "maxTokens") ??
      8192,
    ...(overrides.temperature !== undefined
      ? { temperature: overrides.temperature }
      : pickNumber(project, "temperature") !== undefined
        ? { temperature: pickNumber(project, "temperature") }
        : pickNumber(global, "temperature") !== undefined
          ? { temperature: pickNumber(global, "temperature") }
          : {}),
    maxSteps:
      overrides.maxSteps ??
      pickNumber(project, "maxSteps") ??
      pickNumber(global, "maxSteps") ??
      50,
    contextTokens:
      overrides.contextTokens ??
      pickNumber(project, "contextTokens") ??
      pickNumber(global, "contextTokens") ??
      defaults.contextTokens ??
      200_000,
    autoApprove:
      overrides.autoApprove !== undefined
        ? overrides.autoApprove
        : projectAutoApprove !== undefined
          ? projectAutoApprove
          : globalAutoApprove !== undefined
            ? globalAutoApprove
            : true,
  };
}

export async function saveGlobalConfig(updates: Record<string, unknown>): Promise<string> {
  const file = path.join(homeDir(), ".anycode", "config.json");
  const existing = (await readJsonFile(file)) ?? {};
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ ...existing, ...updates }, null, 2)}\n`, "utf8");
  return file;
}

/**
 * Save a custom provider preset to the global config so it can be reused.
 * The config key is `providers.<id>` with model, baseURL, keyEnv, contextTokens.
 */
export async function saveProviderPreset(id: string, preset: {
  model?: string;
  baseURL?: string;
  keyEnv?: string;
  contextTokens?: number;
  site?: string;
}): Promise<string> {
  const file = path.join(homeDir(), ".anycode", "config.json");
  const existing = (await readJsonFile(file)) ?? {};
  const providers = { ...(existing.providers as Record<string, unknown> ?? {}) };
  providers[id] = { ...preset };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(
    file,
    `${JSON.stringify({ ...existing, providers }, null, 2)}\n`,
    "utf8",
  );
  return file;
}

export interface ProviderPresetDeletion {
  file: string;
  removed: boolean;
}

async function removeProviderPreset(file: string, id: string): Promise<ProviderPresetDeletion> {
  const existing = await readJsonFile(file);
  if (!existing) return { file, removed: false };

  const providers = { ...(existing.providers as Record<string, unknown> ?? {}) };
  if (!(id in providers)) return { file, removed: false };

  delete providers[id];
  if (Object.keys(providers).length === 0) delete existing.providers;
  else existing.providers = providers;

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(existing, null, 2)}\n`, "utf8");
  return { file, removed: true };
}

/** Delete a custom provider preset from the global config. */
export async function deleteProviderPreset(id: string): Promise<ProviderPresetDeletion> {
  return removeProviderPreset(path.join(homeDir(), ".anycode", "config.json"), id);
}

/** Delete a custom provider preset from the project config. */
export async function deleteProjectProviderPreset(
  id: string,
  cwd: string,
): Promise<ProviderPresetDeletion> {
  return removeProviderPreset(path.join(cwd, ".anycode", "config.json"), id);
}
