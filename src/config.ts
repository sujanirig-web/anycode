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
  "anthropic",
  "openai",
  "openai-compatible",
  "ollama",
  "anyroute",
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
}

export function listProviders(): ProviderInfo[] {
  return PROVIDER_IDS.map((id) => ({
    id,
    model: PROVIDER_DEFAULTS[id]?.model ?? "",
    baseURL: PROVIDER_DEFAULTS[id]?.baseURL,
    keyEnv: PROVIDER_DEFAULTS[id]?.keyEnv,
    contextTokens: PROVIDER_DEFAULTS[id]?.contextTokens,
  }));
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
}

const PROVIDER_DEFAULTS: Record<string, ProviderDefaults> = {
  anthropic: { model: "claude-sonnet-4-5", keyEnv: "ANTHROPIC_API_KEY" },
  openai: { model: "gpt-4.1", keyEnv: "OPENAI_API_KEY" },
  "openai-compatible": { model: "", keyEnv: "OPENAI_API_KEY" },
  ollama: { model: "qwen2.5-coder", keyEnv: undefined, baseURL: "http://localhost:11434/v1" },
  anyroute: {
    model: "anyroute",
    keyEnv: "ANYROUTE_API_KEY",
    baseURL: "http://127.0.0.1:3456/v1",
    contextTokens: 1_000_000,
  },
};

export function defaultModelFor(provider: string): string {
  return PROVIDER_DEFAULTS[provider]?.model ?? "";
}

export function apiKeyEnvFor(provider: string): string | undefined {
  return PROVIDER_DEFAULTS[provider]?.keyEnv;
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
      overrides.autoApprove ??
      pickBoolean(project, "autoApprove") ??
      pickBoolean(global, "autoApprove") ??
      false,
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
