import type { Session } from "../agent/session.js";
import { color } from "../util/ansi.js";
import { oneLine } from "../util/text.js";
import { wrapText } from "../util/wrap.js";
import { describeCall, describeFileChangeColored, summarizeToolResult } from "./renderer.js";
import type { ToolCall, Usage } from "../types.js";
import type { FileChange } from "../tools/types.js";
import type { ActivityCard } from "./activity.js";
import { renderCardPanel } from "./card.js";

type BlockKind =
  | "user"
  | "assistant"
  | "tool"
  | "result"
  | "change"
  | "notice"
  | "error"
  | "info"
  | "activity";

interface RenderCache {
  width: number;
  expanded: boolean;
  frame: number | undefined;
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
  change?: FileChange;
}

const CODE_GUTTER = "  │ ";
const RESULT_GUTTER = "  ⎿ ";
const USER_PREFIX = color.green("› ");
const TOOL_PREFIX = color.cyan("⏺ ");
const RESULT_PREFIX = color.green("⎿ ");
const CHANGE_PREFIX = color.cyan("✎ ");
const MAX_COLLAPSED_CHANGE_LINES = 24;
const MAX_EXPANDED_CHANGE_LINES = 200;

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
      for (const line of wrapText(heading[2] ?? "", width)) {
        out.push(color.bold(color.cyan(line)));
      }
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

  pushFileChange(change: FileChange): void {
    this.blocks.push({ kind: "change", text: change.path, change });
  }

  /**
   * Update an activity card in place, or append it if this is a new card.
   * Matching by id keeps separate tool bursts in chronological order.
   */
  updateCurrentActivity(card: ActivityCard): void {
    for (let i = this.blocks.length - 1; i >= 0; i--) {
      const block = this.blocks[i]!;
      if (block.kind === "activity" && block.card?.id === card.id) {
        block.card = card;
        block.cache = undefined;
        return;
      }
    }
    this.pushActivity(card);
  }

  /** Clear render caches after expanding or collapsing cards in place. */
  invalidateActivities(): void {
    for (const block of this.blocks) {
      if (block.kind === "activity") block.cache = undefined;
    }
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

  render(width: number, expanded: boolean, animationFrame?: number): string[] {
    const out: string[] = [];
    for (const block of this.blocks) {
      // Only live activity cards need a per-tick cache key; everything else
      // stays cached until its content or width changes.
      const frame =
        animationFrame !== undefined &&
        block.kind === "activity" &&
        block.card?.steps.some((step) => step.status === "running")
          ? animationFrame
          : undefined;
      if (
        block.cache?.width !== width ||
        block.cache.expanded !== expanded ||
        block.cache.frame !== frame
      ) {
        block.cache = {
          width,
          expanded,
          frame,
          lines: this.renderBlock(block, width, expanded, frame),
        };
      }
      if (out.length > 0) out.push("");
      out.push(...(block.cache?.lines ?? []));
    }

    return out;
  }

  private renderBlock(block: Block, width: number, expanded: boolean, animationFrame?: number): string[] {
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
        const header = `${TOOL_PREFIX}${color.cyan(label)}`;
        const args = block.args ?? "";
        if (args.length === 0) return [header];
        return wrapWithHangingIndent(args, width, `${header} `, "  ");
      }

      case "activity": {
        const card = block.card;
        if (!card || card.steps.length === 0) return [];
        return renderCardPanel(card, Math.max(10, width - 2), undefined, animationFrame, expanded);
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
          : `${RESULT_PREFIX}${color.dim(summary)}`;

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

      case "change": {
        const change = block.change;
        if (!change) return [];
        const out = [`${CHANGE_PREFIX}${describeFileChangeColored(change)}`];
        if (!change.diff) return out;

        const diffLines = change.diff.split(/\r?\n/);
        const limit = expanded ? MAX_EXPANDED_CHANGE_LINES : MAX_COLLAPSED_CHANGE_LINES;
        const shown = diffLines.slice(0, limit);
        for (const line of shown) out.push(`  ${paintDiffLine(line)}`);
        if (diffLines.length > limit) {
          const remaining = diffLines.length - limit;
          out.push(
            color.gray(
              `  … ${remaining} more ${remaining === 1 ? "line" : "lines"}${
                expanded ? "" : " (Ctrl+O to expand)"
              }`,
            ),
          );
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
