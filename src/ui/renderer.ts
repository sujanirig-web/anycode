import type { FileChange, PermissionRequest } from "../tools/types.js";
import { addUsage, EMPTY_USAGE, type ToolCall, type Usage } from "../types.js";
import { color } from "../util/ansi.js";
import { formatNumber, oneLine } from "../util/text.js";
import { truncateWidth } from "../util/width.js";
import { VERSION } from "../version.js";

function stringArg(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function numberArg(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === "number" ? value : undefined;
}

/** One-line summary of a tool call for the transcript. */
export function describeCall(call: ToolCall, input: Record<string, unknown>): string {
  switch (call.name) {
    case "bash": {
      const command = stringArg(input, "command") ?? "";
      // Extract quoted strings (what's being searched for)
      const match = command.match(/["']([^"']+)["']/);
      const quoted = match?.[1];
      if (quoted) {
        // Get just the filename part from the path
        const parts = quoted.split(/[/\\]/);
        let filename = parts[parts.length - 1] ?? quoted;
        // Remove wildcard characters for cleaner display
        filename = filename.replace(/\*/g, "").replace(/\?/g, "");
        // Deduplicate terms separated by | to avoid repetition
        const terms = filename.split(/\s*\|\s*/).filter((t, i, arr) => arr.indexOf(t) === i);
        if (terms[0]) return `searching for ${terms.join(" | ")}`;
      }
      return command;
    }
    case "read":
    case "write":
    case "edit":
      return stringArg(input, "path") ?? "";
    case "glob": {
      const pattern = stringArg(input, "pattern") ?? "";
      // Get just the filename part from the path
      const parts = pattern.split(/[/\\]/);
      let filename = parts[parts.length - 1] ?? pattern;
      // Remove wildcard characters for cleaner display
      filename = filename.replace(/\*/g, "").replace(/\?/g, "");
      return `searching for ${filename}`;
    }
    case "grep": {
      const pattern = stringArg(input, "pattern") ?? "";
      // Deduplicate terms separated by | to avoid repetition
      const terms = pattern.split(/\s*\|\s*/).filter((t, i, arr) => arr.indexOf(t) === i);
      return `searching for ${terms.join(" | ")}`;
    }
    default: {
      const json = JSON.stringify(input);
      return json.length > 80 ? `${json.slice(0, 77)}…` : json;
    }
  }
}

/** Short result summary shown under a tool call. */
export function summarizeToolResult(name: string, content: string): string {
  if (name === "bash") {
    const lines = content.split(/\r?\n/);
    const status = lines.find((line) => line.startsWith("status: "));
    if (status) {
      const stderrIndex = lines.indexOf("--- stderr ---");
      const firstError =
        stderrIndex >= 0 ? lines.slice(stderrIndex + 1).find((line) => line.trim()) : undefined;
      return firstError ? `${status} · ${oneLine(firstError, 100)}` : status;
    }
  }
  const first = content.split(/\r?\n/).find((line) => line.trim()) ?? "(no output)";
  return oneLine(first, 160);
}

function paintDiff(line: string): string {
  if (line.startsWith("@@")) return color.cyan(line);
  if (line.startsWith("+")) return color.green(line);
  if (line.startsWith("-")) return color.red(line);
  return color.dim(line);
}

const CHANGE_PREFIX = `${color.cyan("✎")} `;

/**
 * Semantic tone for a file change, mirroring git diff conventions:
 * additions are green, deletions red, moves copies yellow, directories cyan.
 */
export function changeTone(change: FileChange): (text: string) => string {
  switch (change.kind) {
    case "create":
    case "update":
      return color.green;
    case "delete":
      return color.red;
    case "move":
    case "copy":
      return color.yellow;
    case "mkdir":
      return color.cyan;
  }
}

/** Paint `(+N -M)` stats green/red like a diff summary. */
function paintChangeStats(text: string): string {
  return text
    .replace(/(\+\d+)/g, (match) => color.green(match))
    .replace(/(-\d+)/g, (match) => color.red(match));
}

/** One-line summary of a filesystem change, tinted by its effect. */
export function describeFileChangeColored(change: FileChange): string {
  return changeTone(change)(paintChangeStats(describeFileChange(change)));
}

/** Colored change summary clipped to `width` columns (truncated before painting). */
export function summarizeFileChange(change: FileChange, width: number): string {
  const plain = truncateWidth(describeFileChange(change), Math.max(1, width));
  return changeTone(change)(paintChangeStats(plain));
}

/** One-line summary of a filesystem change. */
export function describeFileChange(change: FileChange): string {
  switch (change.kind) {
    case "create":
    case "update": {
      const stat =
        change.added !== undefined || change.removed !== undefined
          ? ` (+${change.added ?? 0} -${change.removed ?? 0})`
          : "";
      return `${change.kind} ${change.path}${stat}`;
    }
    case "copy":
      return `copy ${change.from ?? change.path} → ${change.to ?? change.path}`;
    case "move":
      return `move ${change.from ?? change.path} → ${change.to ?? change.path}`;
    case "delete":
      return `delete ${change.path}${change.directory ? " (directory)" : ""}`;
    case "mkdir":
      return `create directory ${change.path}`;
  }
}

export class Renderer {
  private textOpen = false;

  constructor(private readonly out: NodeJS.WriteStream = process.stdout) {}

  begin(): void {
    this.textOpen = false;
  }

  text(delta: string): void {
    this.out.write(delta);
    this.textOpen = true;
  }

  endText(): void {
    if (this.textOpen) {
      this.out.write("\n");
      this.textOpen = false;
    }
  }

  blank(): void {
    this.endText();
    this.out.write("\n");
  }

  info(message: string): void {
    this.endText();
    this.out.write(`${color.gray(message)}\n`);
  }

  notice(message: string): void {
    this.endText();
    this.out.write(`${color.yellow("!")} ${message}\n`);
  }

  error(message: string, hint?: string): void {
    this.endText();
    this.out.write(`${color.red("Error:")} ${message}\n`);
    if (hint) this.out.write(`  ${color.gray(hint)}\n`);
  }

  toolStart(call: ToolCall, input: Record<string, unknown>): void {
    this.endText();
    const args = oneLine(describeCall(call, input), 140);
    this.out.write(`${color.cyan("⏺")} ${color.cyan(call.name)} ${color.dim(args)}\n`);
  }

  toolEnd(call: ToolCall, content: string, isError: boolean, durationMs: number): void {
    this.endText();
    const summary = summarizeToolResult(call.name, content);
    const marker = isError ? color.red("⎿") : color.green("⎿");
    const body = isError ? color.red(summary) : color.dim(summary);
    const timing = durationMs >= 500 ? color.gray(` (${(durationMs / 1000).toFixed(1)}s)`) : "";
    this.out.write(`  ${marker} ${body}${timing}\n`);
  }

  fileChange(change: FileChange): void {
    this.endText();
    this.out.write(`${CHANGE_PREFIX}${color.bold(describeFileChangeColored(change))}\n`);
    if (!change.diff) return;

    const limit = 40;
    const lines = change.diff.split(/\r?\n/);
    for (const line of lines.slice(0, limit)) {
      this.out.write(`  ${paintDiff(line)}\n`);
    }
    if (lines.length > limit) {
      this.out.write(color.gray(`  … ${lines.length - limit} more lines\n`));
    }
  }

  permission(request: PermissionRequest): void {
    this.endText();
    this.out.write(`\n${color.yellow(`⚠ ${request.title}`)}\n`);
    if (request.detail) {
      for (const line of request.detail.split(/\r?\n/)) {
        this.out.write(`   ${paintDiff(line)}\n`);
      }
    }
  }

  usage(usage: Usage, previous: Usage = EMPTY_USAGE): void {
    const delta = addUsage(EMPTY_USAGE, {
      inputTokens: Math.max(0, usage.inputTokens - previous.inputTokens),
      outputTokens: Math.max(0, usage.outputTokens - previous.outputTokens),
      cacheReadTokens: Math.max(0, usage.cacheReadTokens - previous.cacheReadTokens),
    });
    if (delta.inputTokens === 0 && delta.outputTokens === 0) return;
    const parts = [
      `${formatNumber(delta.inputTokens)} in`,
      `${formatNumber(delta.outputTokens)} out`,
    ];
    if (usage.cacheReadTokens > 0) parts.push(`${formatNumber(usage.cacheReadTokens)} cached`);
    this.endText();
    this.out.write(`${color.gray(`  ${parts.join(" · ")} tokens`)}\n`);
  }

  banner(options: {
    cwd: string;
    provider: string;
    model: string;
    autoApprove: boolean;
  }): void {
    this.out.write(
      `${color.bold(color.cyan("anycode"))} ${color.gray(`v${VERSION}`)} ${color.gray("·")} ${color.gray(
        `${options.provider}/${options.model}`,
      )}${options.autoApprove ? color.yellow(" · auto-approve") : ""}\n`,
    );
    this.out.write(`${color.gray(options.cwd)}\n`);
    this.out.write(`${color.gray('Type a request, "/help" for commands, Ctrl+C to interrupt.')}\n\n`);
  }
}
