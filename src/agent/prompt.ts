import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NAME, VERSION } from "../version.js";

const RULE_FILES = ["AGENTS.md", "CLAUDE.md", ".anycode/AGENTS.md"];

async function readIfPresent(file: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(file, "utf8");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export async function loadProjectRules(cwd: string): Promise<string | undefined> {
  const chunks: string[] = [];

  const globalRules = await readIfPresent(path.join(os.homedir(), ".anycode", "AGENTS.md"));
  if (globalRules) chunks.push(`## Global instructions\n\n${globalRules}`);

  for (const name of RULE_FILES) {
    const rules = await readIfPresent(path.join(cwd, name));
    if (rules) {
      chunks.push(`## Project instructions (${name})\n\n${rules}`);
      break;
    }
  }

  return chunks.length > 0 ? chunks.join("\n\n") : undefined;
}

export interface SystemPromptOptions {
  cwd: string;
  model: string;
  provider: string;
  extra?: string;
  rules?: string;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const platform =
    process.platform === "win32"
      ? "Windows"
      : process.platform === "darwin"
        ? "macOS"
        : process.platform;

  const shell =
    process.platform === "win32"
      ? process.env.ComSpec?.split("\\").pop() ?? "cmd.exe"
      : process.env.SHELL ?? "/bin/sh";

  const sections = [
    `You are ${NAME} v${VERSION}, an AI coding agent running in a terminal. You help users understand, modify, and ship code.`,
    `# Environment
- Working directory: ${options.cwd}
- Platform: ${platform}
- Default shell: ${shell}
- Date: ${new Date().toISOString().slice(0, 10)}
- Model: ${options.provider}/${options.model}`,
    `# How to work
- Inspect the relevant code before changing it. Read a file before editing it.
- Use the provided tools for all file and shell operations; never claim to have run something you did not run.
- Prefer "edit" for small changes to existing files and "write" for new files or full rewrites.
- Match the project's existing style, naming, and structure. Keep changes focused; do not refactor unrelated code.
- After changing code, run the narrowest relevant tests or type check, then broaden if needed.
- Do not invent APIs or file contents. If something is unknown, look it up with a tool.
- Never print secrets, API keys, tokens, or .env contents.
- Do not create git commits, push, install dependencies, or run destructive commands unless the user asks.
- If you are blocked, state the exact blocker and the best next step instead of guessing.
- Keep prose short. Prefer doing over explaining.
- Do NOT call tools for simple greetings, questions, or conversational replies — answer directly in text. Only use tools when the user asks you to read, write, edit, run, or find something concrete.

# File operations (mandatory)
When the user asks you to create, write, or modify a file, you MUST use the write tool (for new files) or edit tool (for existing files). Do not just describe, explain, or show code snippets in chat — actually write the file to disk using the tools. The user expects a real file to be created, not a verbal answer.`,
    `# Tool notes
- read, list, glob and grep are read-only and safe to call freely.
- write, edit, delete, copy, move, mkdir and bash require user approval unless auto-approve is enabled.
- bash output includes the exit code. A non-zero exit code is information, not necessarily a failure.
- Tool errors include a hint for recovery; adjust your approach instead of repeating the same call.`,
    `# Response style
- Lead with the result, then the important details.
- Use Markdown. Put code in fenced blocks with a language tag.
- At the end of a task, summarize what changed and what you verified.`,
  ];

  if (options.rules) sections.push(`# Project rules\n\n${options.rules}`);
  if (options.extra) sections.push(options.extra);

  return sections.join("\n\n");
}

export async function createSystemPrompt(
  cwd: string,
  provider: string,
  model: string,
  extra?: string,
): Promise<string> {
  const rules = await loadProjectRules(cwd);
  return buildSystemPrompt({ cwd, model, provider, ...(rules ? { rules } : {}), ...(extra ? { extra } : {}) });
}
