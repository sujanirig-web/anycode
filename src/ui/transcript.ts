import type { Session } from "../agent/session.js";
import { color } from "../util/ansi.js";
import { oneLine } from "../util/text.js";
import { wrapText } from "../util/wrap.js";
import { describeCall, summarizeToolResult } from "./renderer.js";
import type { ToolCall, Usage } from "../types.js";
import type { ActivityCard } from "./activity.js";
import { renderCardPanel } from "./card.js";

type BlockKind = "user" | "assistant" | "tool" | "result" | "notice" | "error" | "info" | "activity";

interface RenderCache {
  width: number;
  expanded: boolean;
  lines: string[];
}

interface Block {
  kind: BlockKind;
  text: string;
  name?: string;
  args?: string;
  isError?: boolean;
  durationMs?: number;
  hydrated?: boolean;
  cache?: RenderCache;
  card?: ActivityCard;
  usage?: Usage;
}

const CODE_GUTTER = "  │ ";
const RESULT_GUTTER = "  ⎿ ";
const USER_PREFIX = color.green("› ");
const TOOL_PREFIX = color.blue("⏺ ");
const RESULT_PREFIX = color.gray("⎿ ");

function colorizeInline(line: string): string {
  return line.replace(/`([^`]+)`/g, (_match, code: string) => color.cyan(code));
}

function paintDiffLine(line: string): string {
  if (line.startsWith("@@")) return color.cyan(line);
  if (line.startsWith("+")) return color.green(line);
  if (line.startsWith("-")) return color.red(line);
  return color.dim(line);
}

function renderMarkdown(text: string, width: number): string[] {
  const out: string[] = [];
  let inFence = false;

  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }

    if (inFence) {
      for (const line of wrapText(raw, Math.max(1, width - CODE_GUTTER.length), {
        preserveIndent: true,
      })) {
        out.push(color.dim(CODE_GUTTER + line));
      }
      continue;
    }

    if (raw.trim().length === 0) {
      out.push("");
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      for (const line of wrapText(heading[2] ?? "", width)) out.push(color.bold(line));
      continue;
    }

    for (const line of wrapText(raw, width)) out.push(colorizeInline(line));
  }

  return out;
}

function wrapWithHangingIndent(text: string, width: number, first: string, rest: string): string[] {
  const inner = Math.max(1, width - Math.max(first.length, rest.length));
  const wrapped = wrapText(text, inner);
  return wrapped.map((line, index) => `${index === 0 ? first : rest}${line}`);
}

/**
 * Ordered transcript blocks with per-block render caches. Rendering is pure:
 * the same width/expansion always produces the same lines, so the painter can
 * diff frames cheaply.
 */
export class Transcript {
  readonly blocks: Block[] = [];

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  private currentUsage?: Usage;

  clear(): void {
    this.blocks.length = 0;
  }

  pushUser(text: string): void {
    this.blocks.push({ kind: "user", text });
  }

  pushAssistant(text: string): void {
    this.blocks.push({ kind: "assistant", text });
  }

  pushActivity(card: ActivityCard): void {
    this.blocks.push({ kind: "activity", text: card.intent, card });
  }

  /** Replace the card in the most recent activity block (updates in place). */
  updateCurrentActivity(card: ActivityCard): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]!;
      if (block.kind === "activity") {
        block.card = card;
        block.cache = undefined;
        return;
      }
    }
    this.pushActivity(card);
  }

  appendAssistant(delta: string): void {
    const last = this.blocks[this.blocks.length - 1];
    if (last && last.kind === "assistant") {
      last.text += delta;
      last.cache = undefined;
      return;
    }
    this.pushAssistant(delta);
  }

  setUsage(usage: Usage): void {
    this.currentUsage = usage;
  }

  get usage(): Usage | undefined {
    return this.currentUsage;
  }

  startTool(call: ToolCall, input: Record<string, unknown>): void {
    this.blocks.push({
      kind: "tool",
      text: "",
      name: call.name,
      args: oneLine(describeCall(call, input), 400),
    });
  }

  endTool(
    name: string,
    content: string,
    isError: boolean,
    durationMs: number,
  ): void {
    this.blocks.push({
      kind: "result",
      text: content,
      name,
      isError,
      durationMs,
    });
  }

  pushResult(name: string, content: string, isError: boolean): void {
    this.blocks.push({
      kind: "result",
      text: content,
      name,
      isError,
      durationMs: 0,
      hydrated: true,
    });
  }

  notice(message: string): void {
    this.blocks.push({ kind: "notice", text: message });
  }

  error(message: string, hint?: string): void {
    this.blocks.push({ kind: "error", text: message, ...(hint ? { args: hint } : {}) });
  }

  info(message: string): void {
    this.blocks.push({ kind: "info", text: message });
  }

  welcome(options: { cwd: string; provider: string; model: string; autoApprove: boolean }): void {
    const modelText = `${options.provider}/${options.model}${options.autoApprove ? "  (auto-approve)" : ""}`;
    const lines = [
      `${color.bold(color.magenta("model:"))}  ${color.white(modelText)}`,
    ];
    this.blocks.push({ kind: "info", text: lines.join("\n") });
  }

  hydrate(session: Session): void {
    for (const message of session.messages) {
      if (message.role === "user") {
        this.pushUser(message.content);
      } else if (message.role === "assistant") {
        if (message.content.trim().length > 0) this.pushAssistant(message.content);
      } else if (message.role === "tool") {
        this.pushResult(message.name, message.content, message.isError === true);
      }
    }
  }

  render(width: number, expanded: boolean): string[] {
    const out: string[] = [];
    for (const block of this.blocks) {
      if (block.cache?.width !== width || block.cache.expanded !== expanded) {
        block.cache = { width, expanded, lines: this.renderBlock(block, width, expanded) };
      }
      if (out.length > 0) out.push("");
      out.push(...(block.cache?.lines ?? []));
    }

    return out;
  }

  private renderBlock(block: Block, width: number, expanded: boolean): string[] {
    switch (block.kind) {
      case "user": {
        const wrapped = wrapText(block.text, Math.max(1, width - 2));
        return wrapped.map((line, index) =>
          index === 0 ? `${USER_PREFIX}${color.bold(line)}` : `  ${color.bold(line)}`,
        );
      }

      case "assistant":
        return renderMarkdown(block.text, width);

      case "tool": {
        const label = block.name ?? "tool";
        const header = `${TOOL_PREFIX}${color.gray(label)}`;
        const args = block.args ?? "";
        if (args.length === 0) return [header];
        return wrapWithHangingIndent(args, width, `${header} `, "  ");
      }

      case "activity": {
        const card = block.card;
        if (!card || card.steps.length === 0) return [];
        return renderCardPanel(card, Math.max(10, width - 2));
      }

      case "result": {
        const label = block.hydrated && block.name ? `${block.name} · ` : "";
        const summary = `${label}${summarizeToolResult(block.name ?? "", block.text)}`;
        const timing =
          block.durationMs !== undefined && block.durationMs >= 500
            ? color.gray(` (${(block.durationMs / 1000).toFixed(1)}s)`)
            : "";
        const head = block.isError
          ? `${color.red(RESULT_PREFIX)}${color.red(summary)}`
          : `${color.gray(RESULT_PREFIX)}${color.gray(summary)}`;

        if (!expanded) return [`${head}${timing}`];

        const lines = block.text.split(/\r?\n/);
        const limit = 40;
        const shown = lines.slice(0, limit);
        const out = [`${head}${timing}`];
        if (shown.some((line) => line.trim().length > 0)) {
          out.push("");
          for (const line of shown) {
            const painted = block.isError ? color.red(line) : paintDiffLine(line);
            out.push(`    ${painted}`);
          }
        }
        if (lines.length > limit) {
          out.push(color.gray(`    … ${lines.length - limit} more lines`));
        }
        return out;
      }

      case "notice":
        return wrapWithHangingIndent(block.text, width, `${color.yellow("! ")}`, "  ").map(
          (line, index) => (index === 0 ? line : color.yellow("  ") + line.slice(2)),
        );

      case "error": {
        const wrapped = wrapText(block.text, Math.max(1, width - 2));
        const out = wrapped.map((line, index) =>
          index === 0 ? `${color.red("Error:")} ${line}` : `  ${line}`,
        );
        if (block.args) {
          for (const line of wrapText(block.args, Math.max(1, width - 4))) {
            out.push(`  ${color.dim(line)}`);
          }
        }
        return out;
      }

      case "info":
        return block.text.split(/\r?\n/).flatMap((line) =>
          line.length === 0 ? [""] : wrapText(line, width).map((part) => color.dim(part)),
        );

      default:
        return [];
    }
  }
}
