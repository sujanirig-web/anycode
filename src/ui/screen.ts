import { color } from "../util/ansi.js";
import { padToWidth, stringWidth, truncateWidth } from "../util/width.js";
import { wrapText } from "../util/wrap.js";

export interface ApprovalView {
  title: string;
  detail?: string;
}

export interface FrameInput {
  width: number;
  height: number;
  /** Header text showing active model and working directory. */
  header: string;
  /** Hide the top header bar. */
  showHeader?: boolean;
  /** Already-styled transcript lines. */
  transcript: string[];
  /** Lines scrolled up from the bottom (0 = follow the tail). */
  scroll: number;
  composer: { text: string; cursor: number };
  approval?: ApprovalView;
  /** Token usage for compact display in composer context row. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Agent name for composer placeholder (e.g. "Cavehound", "Atlas"). */
  agentName?: string;
  /** Current agent mode for placeholder derivation. */
  agentMode: "idle" | "running" | "shell" | "plan" | "file-picker";
  /** Agent status strip data. */
  agentStatus?: AgentStatusStripInput;
  /** Deprecated: status line text (left). Kept for backwards compatibility. */
  statusLeft?: string;
  /** Deprecated: status line text (right). Kept for backwards compatibility. */
  statusRight?: string;
}

/** Input for the status strip component. */
export interface AgentStatusStripInput {
  status: "idle" | "working" | "awaiting_approval" | "error" | "cancelled";
  currentIntent?: string;
  currentStep?: number;
  totalSteps?: number;
  durationMs?: number;
  relevantShortcuts?: string;
}

export interface Frame {
  lines: string[];
  cursor?: { row: number; col: number };
  /** Transcript rows available in the frame (for page scrolling). */
  bodyHeight: number;
}

const MIN_WIDTH = 20;
const MIN_HEIGHT = 6;

/** Derive the composer placeholder from application state. */
export function derivePlaceholder(
  composer: { text: string; cursor: number },
  agentName: string | undefined,
  agentMode: "idle" | "running" | "shell" | "plan" | "file-picker",
): string {
  if (composer.text.length > 0) return composer.text;

  if (agentMode === "file-picker") return "Search files…";
  if (agentMode === "running") return "Type to queue your next instruction…";
  if (agentMode === "shell") return "Run a shell command…";
  if (agentMode === "plan") return "Describe what to plan…";
  if (agentName) return `Ask ${agentName}…`;
  return "Type a message…";
}

/** Format token usage compactly: under 1k shows raw, 1k+ uses k suffix. */
export function formatUsage(usage: { inputTokens: number; outputTokens: number }): string {
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${fmt(usage.inputTokens)} in · ${fmt(usage.outputTokens)} out`;
}

/** Clamp a value between min and max. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Header line showing active model and working directory. */
export function headerLine(header: string, width: number): string {
  return color.bold(color.magenta(truncateWidth(header, width - 2)));
}

/** Side-by-side layout for status line. */
export function sideBySide(left: string, right: string, width: number): string {
  const rightText = truncateWidth(right, Math.max(0, width - 10));
  const available = Math.max(0, width - stringWidth(rightText) - 2);
  const leftText = truncateWidth(left, available);
  const gap = Math.max(1, width - stringWidth(leftText) - stringWidth(rightText) - 2);
  return ` ${leftText}${" ".repeat(gap)}${rightText} `;
}

/**
 * Render the agent status strip.
 * Format: <icon> <status label> · <current intent or step> · <duration>
 *         <right-aligned shortcuts>
 */
export function renderStatusStrip(input: AgentStatusStripInput, width: number): string[] {
  const lines: string[] = [];

  const { status, currentIntent, currentStep, totalSteps, durationMs, relevantShortcuts } = input;

  const statusText = statusTextFor(status);
  const statusColor = statusColorFor(status);
  const icon = statusIconFor(status);

  // Build the left portion: icon + status + step info + duration
  // Format: icon statusText · step X · duration · intent
  const leftParts: string[] = [];
  leftParts.push(`${icon} ${statusText}`);

  if (currentStep !== undefined && totalSteps !== undefined) {
    leftParts.push(`step ${currentStep} · ${totalSteps}`);
  } else if (currentStep !== undefined) {
    leftParts.push(`step ${currentStep}`);
  }

  if (durationMs !== undefined) {
    leftParts.push(formatDuration(durationMs));
  }

  if (currentIntent) {
    leftParts.push(truncateWidth(currentIntent, width - 40));
  }

  const leftPart = leftParts.join(" · ");

  // Build right portion: shortcuts
  const rightPart = relevantShortcuts ?? "";

  // Combine with padding
  const leftWidth = stringWidth(leftPart);
  const rightWidth = stringWidth(rightPart);
  const gap = Math.max(1, width - leftWidth - rightWidth - 2);

  lines.push(`  ${leftPart}${" ".repeat(gap)}${rightPart}`);

  return lines;
}

function statusTextFor(status: "idle" | "working" | "awaiting_approval" | "error" | "cancelled"): string {
  switch (status) {
    case "working":
      return "Working";
    case "awaiting_approval":
      return "Waiting for approval";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "";
  }
}

function statusIconFor(status: "idle" | "working" | "awaiting_approval" | "error" | "cancelled"): string {
  switch (status) {
    case "working":
      return "⠴";
    case "awaiting_approval":
      return "⚠";
    case "error":
      return "✗";
    case "cancelled":
      return "Cancelled";
    default:
      return "";
  }
}

function statusColorFor(status: "idle" | "working" | "awaiting_approval" | "error" | "cancelled"): (s: string) => string {
  switch (status) {
    case "working":
      return color.gray;
    case "awaiting_approval":
      return color.yellow;
    case "error":
      return color.red;
    case "cancelled":
      return color.gray;
    default:
      return color.gray;
  }
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Render the Cavehound bottom composer with left accent rail and right-aligned context.
 * The composer must contain only:
 *   - Input row with the "▌" rail and placeholder/text
 *   - Optional second input line for multiline text
 *   - Hint row: "attach · commands · run"
 *   - Context/shortcut row, right-aligned
 */
export function renderCavehoundComposer(
  composer: { text: string; cursor: number },
  width: number,
  agentName: string | undefined,
  agentMode: "idle" | "running" | "shell" | "plan" | "file-picker",
  usage?: { inputTokens: number; outputTokens: number },
): string[] {
  const innerWidth = Math.max(1, width - 4);
  const rail = color.gray("▌");
  const lines: string[] = [];

  const placeholder = derivePlaceholder(composer, agentName, agentMode);
  const text = composer.text.length > 0 ? composer.text : placeholder;
  const textColor = composer.text.length > 0 ? color.white : color.gray;
  const visibleText = truncateWidth(text, innerWidth - 2);

  // Line 1: rail + placeholder/input
  lines.push(`${rail} ${textColor(visibleText)}`);

  // Line 2: rail + hint row (only when idle, not running)
  if (agentMode !== "running") {
    const attach = color.dim("attach");
    const dot = color.dim("·");
    const commands = color.dim("commands");
    const dot2 = color.dim("·");
    const run = color.dim("run");
    lines.push(`${rail} ${attach} ${dot} ${commands} ${dot2} ${run}`);
  }

  // Line 3: context (right-aligned) with usage
  const provider = color.gray("anyroute");
  const cwd = color.gray("~/projects");
  const usagePart = usage ? color.gray(` · ${formatUsage(usage)}`) : "";
  const context = `${provider} · ${cwd}${usagePart}`;
  lines.push(`${rail}${" ".repeat(Math.max(0, innerWidth - stringWidth(context) - 2))}${context}`);

  // Line 4: shortcuts (right-aligned)
  const send = color.dim("↵ send");
  const dot3 = color.dim("·");
  const newline = color.dim("⇧↵ newline");
  const dot4 = color.dim("·");
  const tab = color.dim("Tab queue");
  const shortcuts = `${send} ${dot3} ${newline} ${dot4} ${tab}`;
  lines.push(`${rail}${" ".repeat(Math.max(0, innerWidth - stringWidth(shortcuts) - 2))}${shortcuts}`);

  return lines;
}

/**
 * Layout composer for multiline text wrapping (used internally).
 */
interface ComposerLayout {
  rows: string[];
  cursorRow: number;
  cursorCol: number;
}

function layoutComposer(
  composer: { text: string; cursor: number },
  textWidth: number,
  maxRows: number,
  prefix: string,
  continuation: string,
): ComposerLayout {
  const width = Math.max(1, textWidth);
  const display = composer.text.length === 0 ? [""] : wrapText(composer.text, width);
  const cursor = clamp(composer.cursor, 0, composer.text.length);
  const before = composer.text.slice(0, cursor);
  const prefixLines = before.length === 0 ? [""] : wrapText(before, width);
  const cursorLine = Math.max(0, prefixLines.length - 1);
  const cursorColumn = stringWidth(prefixLines[prefixLines.length - 1] ?? "");

  const rows = Math.min(maxRows, Math.max(1, display.length));
  const scrolled = Math.max(0, cursorLine - (rows - 1));
  const visible: string[] = [];
  for (let index = 0; index < rows; index++) {
    visible.push(display[scrolled + index] ?? "");
  }

  const prefixWidth = stringWidth(prefix);
  return {
    rows: visible.map((line, index) => `${index === 0 ? prefix : continuation}${line}`),
    cursorRow: clamp(cursorLine - scrolled, 0, rows - 1),
    cursorCol: prefixWidth + Math.min(cursorColumn, width - 1),
  };
}

/**
 * Compose a full-screen frame: header, scrollable transcript, status strip,
 * composer box. Pure and deterministic so it can be tested without a terminal.
 */
export function composeFrame(input: FrameInput): Frame {
  const width = Math.max(MIN_WIDTH, Math.floor(input.width));
  const height = Math.max(MIN_HEIGHT, Math.floor(input.height));

  const showHeader = input.showHeader !== false;
  const bordered = width >= 34 && height >= 12;
  const headerRows = showHeader && bordered ? 2 : 0; // header line + blank spacer
  const borderRows = bordered ? 2 : 0;

  const maxInputRows = Math.max(1, bordered ? height - 8 : 3);
  const textWidth = bordered ? width - 5 : width - 2;
  const prefix = bordered ? color.green(" › ") : color.green("› ");
  const continuation = "   ";

  const composer = layoutComposer(input.composer, textWidth, maxInputRows, prefix, continuation);

  const inputRows = composer.rows.length;
  const composerHeight = inputRows + borderRows;
  const bodyTop = bordered ? (showHeader ? 2 : 0) : 0;

  // Status strip takes 1 row when there's an active status
  const statusStripRows = input.agentStatus ? 1 : 0;

  let bodyHeight = height - bodyTop - composerHeight - headerRows - statusStripRows;

  if (bodyHeight < 1) {
    bodyHeight = 1;
  }

  const lines: string[] = [];
  if (showHeader && bordered) {
    lines.push(headerLine(input.header, width));
    lines.push("");
  }

  const total = input.transcript.length;
  const scroll = clamp(input.scroll, 0, Math.max(0, total - 1));
  const end = Math.max(0, total - scroll);
  const start = Math.max(0, end - bodyHeight);
  const visible = input.transcript.slice(start, end);
  while (visible.length < bodyHeight) visible.unshift("");

  if (scroll > 0 && visible.length > 0) {
    const label = ` ↓ ${scroll} line${scroll === 1 ? "" : "s"} below `;
    visible[0] = color.dim(label);
  }

  for (const line of visible) lines.push(truncateWidth(` ${line}`, width));

  // One blank line between transcript content and status strip/composer
  lines.push("");

  // Status strip (separate from composer, no ▌ rail)
  if (input.agentStatus) {
    const statusLines = renderStatusStrip(input.agentStatus, width);
    lines.push(...statusLines);
    // One blank line between status strip and composer
    lines.push("");
  }

  const composerLines = renderCavehoundComposer(
    input.composer,
    input.width,
    input.agentName,
    input.agentMode,
    input.usage,
  );
  const composerStartRow = lines.length;
  lines.push(...composerLines);

  while (lines.length < height) lines.push("");
  const frame = lines.slice(0, height);

  if (input.approval) return { lines: frame, bodyHeight };

  const cursorRow = composerStartRow;
  const cursorCol = clamp(2 + input.composer.cursor, 0, width - 1);
  return {
    lines: frame,
    bodyHeight,
    cursor: {
      row: clamp(cursorRow, 0, height - 1),
      col: clamp(cursorCol, 0, width - 1),
    },
  };
}
