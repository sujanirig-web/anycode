import { stdin as input, stdout as output } from "node:process";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import path from "node:path";

import { Agent } from "./agent/agent.js";
import { PermissionBroker } from "./agent/permissions.js";
import { createSystemPrompt } from "./agent/prompt.js";
import { Session, latestSession, listSessions } from "./agent/session.js";
import { loadConfig, saveProviderPreset, listProviders, type Config, type ConfigOverrides } from "./config.js";
import { UserError, errorMessage } from "./errors.js";
import { createProvider } from "./llm/index.js";
import { color } from "./util/ansi.js";
import { Spinner } from "./util/spinner.js";
import { oneLine } from "./util/text.js";
import { createAskPermission } from "./ui/ask.js";
import { Renderer } from "./ui/renderer.js";
import { runRepl, type ReplRuntime } from "./ui/repl.js";
import { runTui } from "./ui/tui.js";
import { NAME, VERSION } from "./version.js";

const OPTIONS = {
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  model: { type: "string", short: "m" },
  provider: { type: "string", short: "p" },
  "base-url": { type: "string" },
  "api-key": { type: "string" },
  yolo: { type: "boolean", short: "y" },
  json: { type: "boolean" },
  session: { type: "string", short: "s" },
  continue: { type: "boolean", short: "c" },
  "max-steps": { type: "string" },
  "max-tokens": { type: "string" },
  "no-color": { type: "boolean" },
  "no-tui": { type: "boolean" },
  cwd: { type: "string" },
} as const;

const HELP = `${NAME} ${VERSION} — a small terminal AI coding agent

Usage:
  ${NAME}                     Start the interactive TUI
  ${NAME} "<task>"            Run one task and exit
  ${NAME} run "<task>"        Same, explicit form
  ${NAME} resume [id]         Resume a session (default: most recent)
  ${NAME} sessions            List saved sessions for this directory
  ${NAME} config              Show the effective configuration

Options:
  -m, --model <name>          Model to use
  -p, --provider <id>         anthropic | openai | openai-compatible | ollama | anyroute
      --base-url <url>        Override the provider base URL (local models, proxies)
      --api-key <key>         Override the API key (prefer environment variables)
  -s, --session <id>          Resume a specific session
  -c, --continue              Continue the most recent session
  -y, --yolo                  Auto-approve write, edit and bash (no prompts)
      --json                  Stream events as newline-delimited JSON
      --cwd <dir>             Run against another working directory
      --no-tui                Use the plain line REPL instead of the full-screen UI
      --max-steps <n>         Maximum agent steps per turn (default 50)
      --max-tokens <n>        Maximum output tokens per model call
  -h, --help                  Show this help
  -v, --version               Show the version

Environment:
  ANYCODE_PROVIDER, ANYCODE_MODEL, ANYCODE_BASE_URL, ANYCODE_API_KEY
  ANTHROPIC_API_KEY, OPENAI_API_KEY, ANYROUTE_API_KEY

Examples:
  ${NAME} "explain this codebase"
  ${NAME} -m gpt-4.1 "add tests for src/utils.ts"
  ${NAME} -p ollama -m qwen2.5-coder "fix the failing test"
  ${NAME} -p anyroute -m anyroute "fix the failing test"
  ${NAME} --json "list the TODO comments" > events.ndjson

Config files (later wins):
  ~/.anycode/config.json
  ./.anycode/config.json
`;

function toPositiveInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new UserError(`--${flag} must be a positive integer (got "${value}").`);
  }
  return parsed;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

function maskKey(key: string | undefined): string {
  if (!key) return "(not set)";
  if (key.length <= 8) return "(set)";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

function printConfig(config: Config): void {
  console.log(`provider:      ${config.provider}`);
  console.log(`model:         ${config.model}`);
  console.log(`base URL:      ${config.baseURL ?? "(provider default)"}`);
  console.log(`api key:       ${maskKey(config.apiKey)}`);
  console.log(`max tokens:    ${config.maxTokens}`);
  console.log(`max steps:     ${config.maxSteps}`);
  console.log(`context:       ${config.contextTokens} tokens`);
  console.log(`auto-approve:  ${config.autoApprove ? "yes" : "no"}`);
}

function printSessions(metas: Awaited<ReturnType<typeof listSessions>>): number {
  if (metas.length === 0) {
    console.log("No saved sessions in this directory.");
    return 0;
  }
  for (const meta of metas) {
    console.log(
      `${meta.id}  ${meta.updatedAt.slice(0, 16).replace("T", " ")}  ${String(
        meta.messageCount,
      ).padStart(3)} msgs  ${oneLine(meta.title, 60)}`,
    );
  }
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
  const values = parsed.values;
  const positionals = parsed.positionals;

  if (values.version) {
    console.log(`${NAME} ${VERSION}`);
    return 0;
  }
  if (values.help) {
    console.log(HELP);
    return 0;
  }

  const cwd = path.resolve(values.cwd ?? process.cwd());
  const first = positionals[0];

  if (first === "help") {
    console.log(HELP);
    return 0;
  }
  if (first === "version") {
    console.log(`${NAME} ${VERSION}`);
    return 0;
  }
  if (first === "sessions") {
    return printSessions(await listSessions(cwd));
  }

  let prompt = "";
  let resumeId = values.session;
  let wantsLatest = Boolean(values["continue"]);

  if (first === "resume") {
    resumeId = positionals[1] ?? values.session;
    wantsLatest = !resumeId;
    prompt = positionals.slice(2).join(" ");
  } else if (first === "run") {
    prompt = positionals.slice(1).join(" ");
  } else {
    prompt = positionals.join(" ");
  }

  let session: Session | undefined;
  if (wantsLatest) {
    session = await latestSession(cwd);
    if (!session) throw new UserError("No sessions found in this directory.");
  } else if (resumeId) {
    try {
      session = await Session.load(cwd, resumeId);
    } catch (error) {
      throw new UserError(
        `Could not load session "${resumeId}": ${errorMessage(error)}`,
        "Run `anycode sessions` to list saved sessions.",
      );
    }
  }

  const overrides: ConfigOverrides = {
    ...(values.provider ? { provider: values.provider } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
    ...(values["api-key"] ? { apiKey: values["api-key"] } : {}),
    ...(values.yolo ? { autoApprove: true } : {}),
  };
  const maxSteps = toPositiveInt(values["max-steps"], "max-steps");
  const maxTokens = toPositiveInt(values["max-tokens"], "max-tokens");
  if (maxSteps !== undefined) overrides.maxSteps = maxSteps;
  if (maxTokens !== undefined) overrides.maxTokens = maxTokens;

  if (!overrides.provider && session?.provider) overrides.provider = session.provider;
  if (!overrides.model && session?.model) overrides.model = session.model;

  const config = await loadConfig(cwd, overrides);

  if (first === "config") {
    printConfig(config);
    return 0;
  }

  if (!config.model) {
    throw new UserError(
      "No model configured.",
      "Pass --model, set ANYCODE_MODEL, or add {\"model\": \"...\"} to .anycode/config.json.",
    );
  }

  session ??= Session.create({ cwd, provider: config.provider, model: config.model });

  const jsonMode = Boolean(values.json);
  if (!prompt && !input.isTTY) prompt = (await readStdin()).trim();

  const interactive = !prompt && !jsonMode && Boolean(input.isTTY);
  const resumeInteractive =
    !prompt && Boolean(input.isTTY) && Boolean(session) && resumeId !== undefined;

  if (!interactive && !resumeInteractive && !prompt) {
    throw new UserError(
      "No prompt provided.",
      `Run \`${NAME}\` for the interactive UI, or \`${NAME} "your task"\`.`,
    );
  }
  if (jsonMode && !prompt) {
    throw new UserError("--json requires a prompt.");
  }

  const broker = new PermissionBroker(config.autoApprove);

  const build = async (
    forSession: Session,
    providerId: string,
    model: string,
  ): Promise<{ agent: Agent; config: Config }> => {
    const effective = await loadConfig(cwd, {
      provider: providerId,
      model,
      ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
      ...(values["api-key"] ? { apiKey: values["api-key"] } : {}),
      ...(maxSteps !== undefined ? { maxSteps } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      autoApprove: broker.autoApprove,
    });

    const provider = createProvider({
      id: providerId,
      model,
      ...(effective.apiKey ? { apiKey: effective.apiKey } : {}),
      ...(effective.baseURL ? { baseURL: effective.baseURL } : {}),
    });
    const system = await createSystemPrompt(cwd, providerId, model);
    forSession.provider = providerId;
    forSession.model = model;

    const agent = new Agent({
      provider,
      model,
      cwd,
      session: forSession,
      system,
      maxSteps: effective.maxSteps,
      maxTokens: effective.maxTokens,
      contextTokens: effective.contextTokens,
      ...(effective.temperature !== undefined ? { temperature: effective.temperature } : {}),
      approve: (request) => broker.approve(request),
    });

    return { agent, config: effective };
  };

  const built = await build(session, config.provider, config.model);
  const agent = built.agent;
  const effectiveConfig = built.config;

  const useTui =
    !values["no-tui"] &&
    !process.env.ANYCODE_NO_TUI &&
    Boolean(input.isTTY) &&
    Boolean(output.isTTY);

  if (interactive || resumeInteractive) {
    const runtime: ReplRuntime = {
      cwd,
      session,
      agent,
      providerId: effectiveConfig.provider,
      model: effectiveConfig.model,
      broker,
      rebuild: async (changes) => {
        const providerId = changes.providerId ?? runtime.providerId;
        const model = changes.model?.trim() || runtime.model;
        const nextSession = changes.session ?? runtime.session;
        const result = await build(nextSession, providerId, model);
        runtime.agent = result.agent;
        runtime.session = nextSession;
        runtime.providerId = result.config.provider;
        runtime.model = result.config.model;
        return {
          agent: result.agent,
          session: nextSession,
          providerId: runtime.providerId,
          model: runtime.model,
        };
      },
      listSessions: () => listSessions(cwd),
      loadSession: (id) => Session.load(cwd, id),
      listProviders: async () => listProviders(),
      saveProvider: async (id, preset) => {
        await saveProviderPreset(id, preset);
      },
    };

    await (useTui ? runTui(runtime) : runRepl(runtime));
    return 0;
  }

  const renderer = new Renderer();
  const spinner = new Spinner("thinking");
  const controller = new AbortController();
  const before = { ...session.usage };
  let exitCode = 0;
  let rl: ReturnType<typeof createInterface> | undefined;

  if (input.isTTY && !jsonMode) {
    rl = createInterface({ input, output });
    broker.handler = createAskPermission({
      rl,
      renderer,
      spinner,
      signal: controller.signal,
    });
  }

  const onSigint = () => controller.abort();
  process.on("SIGINT", onSigint);

  try {
    renderer.begin();

    for await (const event of agent.run(prompt, { signal: controller.signal })) {
      if (jsonMode) {
        output.write(`${JSON.stringify(event)}\n`);
        if (event.type === "error" && !event.recoverable) exitCode = 1;
        if (event.type === "done" && event.aborted) exitCode = 130;
        continue;
      }

      switch (event.type) {
        case "turn_start":
          spinner.start(event.step > 1 ? `step ${event.step}` : "thinking");
          break;
        case "text":
          spinner.stop();
          renderer.text(event.text);
          break;
        case "reasoning":
          break;
        case "tool_start":
          spinner.stop();
          renderer.toolStart(event.call, event.input);
          break;
        case "tool_end":
          spinner.stop();
          renderer.toolEnd(event.call, event.content, event.isError, event.durationMs);
          break;
        case "usage":
          break;
        case "compaction":
          renderer.notice(
            `Trimmed ${event.removedMessages} old messages to stay inside the context window.`,
          );
          break;
        case "notice":
          spinner.stop();
          renderer.notice(event.message);
          break;
        case "error":
          spinner.stop();
          renderer.error(event.message, event.hint);
          if (!event.recoverable) exitCode = 1;
          break;
        case "done":
          spinner.stop();
          if (event.aborted) {
            renderer.notice("Interrupted.");
            exitCode = 130;
          }
          break;
      }
    }
  } catch (error) {
    spinner.stop();
    if (!controller.signal.aborted) {
      renderer.error(errorMessage(error));
      exitCode = 1;
    }
  } finally {
    spinner.stop();
    renderer.endText();
    process.off("SIGINT", onSigint);
    rl?.close();
  }

  if (!jsonMode) renderer.usage(session.usage, before);
  await session.save().catch(() => undefined);

  return exitCode;
}

export { HELP };
