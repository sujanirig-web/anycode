import { chromeBackground, color, composerBackground, panelBackground, stripAnsi } from "../util/ansi.js";
import { padToWidth, stringWidth, truncateWidth } from "../util/width.js";

export interface ApprovalView {
  title: string;
  detail?: string;
}

/** Active model info shown inside the composer. */
export interface ModelInfo {
  provider: string;
  model: string;
  autoApprove: boolean;
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
  /** Token usage for compact right-aligned display in the composer. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Active provider/model shown in the composer below the waveform. */
  model?: ModelInfo;
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
  /** Animated spinner frame shown when status is "working". */
  frame?: string;
  /** Animated waveform bars shown when status is "working". Replaces `frame` when set. */
  waveform?: string;
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

  const {
    status,
    currentIntent,
    currentStep,
    totalSteps,
    durationMs,
    relevantShortcuts,
  } = input;

  const statusText = statusTextFor(status);
  const statusColor = statusColorFor(status);

  // Build the left portion: icon + status + step info + duration
  // Format: icon statusText · step X · duration · intent
  const leftParts: string[] = [];
  const icon = status === "working" && input.frame ? input.frame : statusIconFor(status);
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
 * The composer contains only:
 *   - Input row with the "▌" rail and placeholder/text
 *   - Optional second input line for multiline text
 *   - Usage row (right-aligned)
 *   - Waveform row (left-aligned) while the agent is running
 *   - Model row (left-aligned) below the waveform
 *   - Bottom padding row
 *
 * The "attach · commands · run" hint is rendered outside the interface on the
 * bottom edge, below the composer gap, so it never shares the input rail.
 */
export function renderCavehoundComposer(
  composer: { text: string; cursor: number },
  width: number,
  agentName: string | undefined,
  agentMode: "idle" | "running" | "shell" | "plan" | "file-picker",
  usage?: { inputTokens: number; outputTokens: number },
  waveform?: string,
  model?: ModelInfo,
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

  // Line 2: token usage only, right-aligned. The provider/cwd label is gone.
  if (usage) {
    const usageText = color.gray(formatUsage(usage));
    lines.push(`${rail}${" ".repeat(Math.max(0, innerWidth - stringWidth(usageText) - 2))}${usageText}`);
  }

  // Line 3: waveform sits below the context while working. Truncate it on
  // narrow terminals so it can never wrap into the model row.
  if (agentMode === "running" && waveform) {
    const wave =
      stringWidth(waveform) <= innerWidth
        ? waveform
        : truncateWidth(stripAnsi(waveform), innerWidth);
    lines.push(`${rail} ${wave}`);
  }

  // Line 4: active model, on its own row below the waveform so the two can
  // never collide.
  if (model) {
    const suffix = model.autoApprove ? "  (auto-approve)" : "";
    const modelText = `${model.provider}/${model.model}${suffix}`;
    const fitted = truncateWidth(modelText, Math.max(1, innerWidth - 6));
    lines.push(`${rail} ${color.magenta("model:")}  ${color.white(fitted)}`);
  }

  // Bottom padding stretches the composer surface taller.
  lines.push("", "", "");

  return lines;
}

/** Blank rows kept below the composer; the composer's padding replaces the gap. */
const COMPOSER_BOTTOM_GAP = 0;

/** Plain hint rendered below the composer, outside the input rail. */
const COMPOSER_FOOTER = "attach · commands · run";

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

  const composerLines = renderCavehoundComposer(
    input.composer,
    input.width,
    input.agentName,
    input.agentMode,
    input.usage,
    input.agentStatus?.waveform,
    input.model,
  );
  const statusLines = input.agentStatus ? renderStatusStrip(input.agentStatus, width) : [];
  // One blank line before the status strip and one between it and the composer.
  const statusBlockRows = statusLines.length > 0 ? statusLines.length + 1 : 0;

  // Reserve fixed chrome first, then spend whatever is left on the transcript
  // and the bottom gap. Shrinking the gap keeps small terminals usable.
  const footerRows = 1;
  const fixedRows =
    headerRows + 1 + statusBlockRows + composerLines.length + footerRows;
  const bottomGap = Math.max(
    0,
    Math.min(COMPOSER_BOTTOM_GAP, height - fixedRows - 1),
  );
  let bodyHeight = height - fixedRows - bottomGap;
  if (bodyHeight < 1) bodyHeight = 1;

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

  // Tint the conversation body. Stop one column short of the right edge so
  // the painter's end-of-line erase cannot clip the last cell.
  const chatStart = lines.length;
  for (const line of visible) {
    const text = truncateWidth(` ${line}`, width - 1);
    lines.push(panelBackground(padToWidth(text, width - 1)));
  }
  const chatEnd = lines.length;

  // Status strip (separate from composer, no ▌ rail)
  if (statusLines.length > 0) {
    lines.push(...statusLines);
    // One blank line between status strip and composer
    lines.push("");
  }

  const composerStartRow = lines.length;
  lines.push(...composerLines);

  // Optional gap below the composer (the footer normally anchors the edge).
  for (let index = 0; index < bottomGap; index++) lines.push("");

  while (lines.length < height - 1) lines.push("");

  // Hint footer lives outside the interface, pinned to the bottom edge.
  lines.push(color.dim(truncateWidth(COMPOSER_FOOTER, width)));

  // Darken the whole canvas; keep only the composer on its lighter surface.
  const composerEndRow = composerStartRow + composerLines.length;
  const frame = lines.slice(0, height).map((line, index) => {
    if (index >= chatStart && index < chatEnd) return line;
    if (index >= composerStartRow && index < composerEndRow) {
      return composerBackground(padToWidth(line, width - 1));
    }
    return chromeBackground(padToWidth(line, width - 1));
  });

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
