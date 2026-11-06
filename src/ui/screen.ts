import { chromeBackground, color, composerBackground, panelBackground, stripAnsi } from "../util/ansi.js";
import { codePointCells, padToWidth, stringWidth, truncateWidth } from "../util/width.js";
import { INFINITY_WIDTH, renderInfinityMark } from "./infinity.js";

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

/** A centered modal used by the command palette and pickers. */
export interface OverlayView {
  title: string;
  body: string[];
  footer?: string;
  /** Index in `body` to render as a full-width selected row. */
  highlight?: number;
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
  /** Centered command panel rendered over the conversation body. */
  overlay?: OverlayView;
  /** Prompts pinned outside the scrollable transcript until their turn starts. */
  queuedPrompts?: readonly string[];
  /** Show the centered retro wordmark while the session is empty. */
  showBrand?: boolean;
  /** Lines scrolled up from the bottom (0 = follow the tail). */
  scroll: number;
  composer: { text: string; cursor: number };
  approval?: ApprovalView;
  /** Token usage for compact right-aligned display in the composer. */
  usage?: { inputTokens: number; outputTokens: number };
  /** Active provider/model shown in the composer. */
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

/** A multi-row mark rendered to the left of the status text. */
export interface StatusGlyph {
  /** Visible width of each glyph row in terminal columns. */
  width: number;
  /** Styled glyph rows. They may contain ANSI color and are not padded. */
  lines: readonly string[];
}

/** Input for the status strip component. */
export interface AgentStatusStripInput {
  status: "idle" | "working" | "awaiting_approval" | "error" | "cancelled";
  currentIntent?: string;
  currentStep?: number;
  totalSteps?: number;
  durationMs?: number;
  relevantShortcuts?: string;
  /** Single-cell spinner frame shown when status is "working". May contain ANSI color. */
  frame?: string;
  /** Multi-row working icon; replaces `frame` and the built-in status icon. */
  glyph?: StatusGlyph;
  /** Files touched in the current turn, shown as a running count. */
  changedFiles?: number;
}

export interface Frame {
  lines: string[];
  cursor?: { row: number; col: number };
  /** Transcript rows available in the frame (for page scrolling). */
  bodyHeight: number;
}

const MIN_WIDTH = 20;
const MIN_HEIGHT = 6;

const WORDMARK_5X5: Record<string, string[]> = {
  A: [".###.", "#...#", "#...#", "#####", "#...#"],
  N: ["#...#", "##..#", "#.#.#", "#..##", "#...#"],
  Y: ["#...#", "#...#", ".#.#.", "..#..", "..#.."],
  C: [".###.", "#...#", "#....", "#...#", ".###."],
  O: [".###.", "#...#", "#...#", "#...#", ".###."],
  D: ["####.", "#...#", "#...#", "#...#", "####."],
  E: ["#####", "#....", "####.", "#....", "#####"],
};

const WORDMARK_3X5: Record<string, string[]> = {
  A: [".#.", "#.#", "###", "#.#", "#.#"],
  N: ["#.#", "###", "###", "#.#", "#.#"],
  Y: ["#.#", "#.#", ".#.", ".#.", ".#."],
  C: [".##", "#..", "#..", "#..", ".##"],
  O: [".#.", "#.#", "#.#", "#.#", ".#."],
  D: ["##.", "#.#", "#.#", "#.#", "##."],
  E: ["###", "#..", "##.", "#..", "###"],
};

function wordmarkRows(word: string, font: Record<string, string[]>, gap: string): string[] {
  return Array.from({ length: 5 }, (_, row) =>
    [...word]
      .map((letter) => (font[letter]?.[row] ?? "").replace(/#/g, "█").replace(/\./g, " "))
      .join(gap),
  );
}

function renderRetroWordmark(width: number, bodyHeight: number): string[] {
  // The braille infinity is 15x3, roughly 30% of the full 47x10 wordmark.
  const mark = width >= INFINITY_WIDTH
    ? renderInfinityMark()
    : [color.bold(color.magenta("∞"))];
  const markWidth = width >= INFINITY_WIDTH ? INFINITY_WIDTH : 1;

  if (bodyHeight < 6 || width < 29) {
    return [color.gray(color.bold("A N Y C O D E")), ...mark];
  }

  const font = width >= 50 ? WORDMARK_5X5 : WORDMARK_3X5;
  const gap = width >= 50 ? "  " : " ";
  const leftRows = wordmarkRows("ANY", font, gap);
  const rightRows = wordmarkRows("CODE", font, gap);
  const leftWidth = stringWidth(leftRows[0] ?? "");
  const rightWidth = stringWidth(rightRows[0] ?? "");
  const separator = gap;
  const inlineWidth = leftWidth + separator.length + markWidth + separator.length + rightWidth;
  // Doubling the rows needs 13 lines of body space once the mark is added.
  const expanded = width >= 50 && bodyHeight >= 13;

  // Put the infinity between ANY and CODE, vertically centered on the letters.
  if (inlineWidth <= width) {
    const rows = expanded ? leftRows.flatMap((line) => [line, line]) : leftRows;
    const right = expanded ? rightRows.flatMap((line) => [line, line]) : rightRows;
    const markTop = Math.floor((rows.length - mark.length) / 2);
    const blankMark = " ".repeat(markWidth);
    return rows.map((left, index) => {
      const markLine = index >= markTop && index < markTop + mark.length
        ? mark[index - markTop] ?? blankMark
        : blankMark;
      return `${color.gray(color.bold(left))}${separator}${markLine}${separator}${color.gray(color.bold(right[index] ?? ""))}`;
    });
  }

  const glyphRows = wordmarkRows("ANYCODE", font, gap);
  const expandedRows = expanded ? glyphRows.flatMap((line) => [line, line]) : glyphRows;
  return [...expandedRows.map((line) => color.gray(color.bold(line))), ...mark];
}

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

interface ComposerTextLayout {
  rows: string[];
  cursorRow: number;
  cursorColumn: number;
}

function layoutComposerText(text: string, width: number, cursor: number): ComposerTextLayout {
  const rows = [""];
  const targetCursor = clamp(cursor, 0, text.length);
  let row = 0;
  let column = 0;
  let cursorRow = 0;
  let cursorColumn = 0;
  let cursorPlaced = false;

  for (let index = 0; index < text.length;) {
    const codePoint = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(codePoint);
    const nextIndex = index + char.length;

    if (char === "\n") {
      if (!cursorPlaced && targetCursor === index) {
        cursorRow = row;
        cursorColumn = column;
        cursorPlaced = true;
      }
      rows.push("");
      row++;
      column = 0;
      index = nextIndex;
      continue;
    }

    const charWidth = codePointCells(char);
    if (column > 0 && column + charWidth > width) {
      rows.push("");
      row++;
      column = 0;
    }
    if (!cursorPlaced && targetCursor === index) {
      cursorRow = row;
      cursorColumn = column;
      cursorPlaced = true;
    }
    rows[row] = `${rows[row] ?? ""}${char}`;
    column += charWidth;
    index = nextIndex;
  }

  if (!cursorPlaced) {
    cursorRow = row;
    cursorColumn = column;
  }

  return { rows, cursorRow, cursorColumn };
}

function composerViewport(layout: ComposerTextLayout, maxRows: number): { start: number; end: number } {
  const visibleRows = Math.max(1, Math.min(layout.rows.length, Math.floor(maxRows)));
  const maxStart = Math.max(0, layout.rows.length - visibleRows);
  const start = clamp(layout.cursorRow - visibleRows + 1, 0, maxStart);
  return { start, end: start + visibleRows };
}

function renderQueuedPrompts(prompts: readonly string[], width: number, maxRows: number): string[] {
  if (prompts.length === 0 || maxRows <= 0) return [];
  const rows = [color.yellow(`  QUEUED · ${prompts.length}`)];
  const availableItems = prompts.length > maxRows - 1
    ? Math.max(0, maxRows - 2)
    : maxRows - 1;
  const shown = Math.min(prompts.length, availableItems);
  for (let index = 0; index < shown; index++) {
    const prompt = prompts[index] ?? "";
    const compact = prompt.replace(/\s+/g, " ");
    rows.push(color.gray(truncateWidth(`  ${index + 1}. ${compact}`, Math.max(1, width - 2))));
  }
  if (shown < prompts.length && rows.length < maxRows) {
    rows.push(color.dim(`  + ${prompts.length - shown} more · Ctrl+Q manage`));
  }
  return rows;
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

/**
 * Render the agent status strip.
 * Format: <icon> <status label> · <current intent or step> · <duration>
 *         <right-aligned shortcuts>
 */
export function renderStatusStrip(input: AgentStatusStripInput, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const glyph = input.glyph;

  if (!glyph || glyph.lines.length === 0 || glyph.width < 1) {
    return [buildStatusLine(input, safeWidth)];
  }

  // The icon sits on the left; the status text is vertically centered beside
  // it so it lines up with the waist of the infinity.
  const glyphGap = 2;
  const glyphIndent = 1;
  const statusWidth = Math.max(1, safeWidth - glyph.width - glyphGap - glyphIndent);
  const statusLine = buildStatusLine(input, statusWidth, false);
  const blankStatus = " ".repeat(statusWidth);
  const focusRow = Math.floor(glyph.lines.length / 2);

  return glyph.lines.map((glyphLine, index) =>
    padToWidth(
      `${" ".repeat(glyphIndent)}${glyphLine}${" ".repeat(glyphGap)}${
        index === focusRow ? statusLine : blankStatus
      }`,
      safeWidth,
    ),
  );
}

/** Build the single status row: icon + status + step/duration + shortcuts. */
function buildStatusLine(input: AgentStatusStripInput, width: number, showIcon = true): string {
  const safeWidth = Math.max(1, width);

  const {
    status,
    currentIntent,
    currentStep,
    totalSteps,
    durationMs,
    relevantShortcuts,
    changedFiles,
  } = input;

  const statusText = statusTextFor(status);
  const icon = status === "working" && input.frame ? input.frame : statusIconFor(status);
  const heading = showIcon ? `${icon} ${statusText}` : statusText;
  const headingWidth = stringWidth(heading);

  // Keep the icon out of truncation: it may carry ANSI color, and it is the
  // one part of the strip that should never be clipped.
  const details: string[] = [];
  if (currentStep !== undefined && totalSteps !== undefined) {
    details.push(color.cyan(`step ${currentStep} · ${totalSteps}`));
  } else if (currentStep !== undefined) {
    details.push(color.cyan(`step ${currentStep}`));
  }

  if (changedFiles !== undefined && changedFiles > 0) {
    details.push(
      color.green(`${changedFiles} file${changedFiles === 1 ? "" : "s"} changed`),
    );
  }

  if (durationMs !== undefined) {
    details.push(color.gray(formatDuration(durationMs)));
  }

  if (currentIntent) {
    details.push(color.dim(truncateWidth(currentIntent, Math.max(0, safeWidth - 20))));
  }

  let rightPart = relevantShortcuts ?? "";
  rightPart = truncateWidth(rightPart, Math.max(0, safeWidth - headingWidth - 4));

  const rightWidth = stringWidth(rightPart);
  const detailsBudget = Math.max(0, safeWidth - headingWidth - rightWidth - 4);
  const detailText = details.length > 0 ? ` · ${details.join(" · ")}` : "";
  const leftPart = `${heading}${truncateWidth(detailText, detailsBudget)}`;

  const gap = Math.max(1, safeWidth - stringWidth(leftPart) - rightWidth - 2);
  let line = `  ${leftPart}${" ".repeat(gap)}${rightPart}`;
  // Extreme narrow terminals: fall back to plain text so the row never overflows.
  if (stringWidth(line) > safeWidth) line = truncateWidth(stripAnsi(line), safeWidth);
  return padToWidth(line, safeWidth);
}

function statusTextFor(status: "idle" | "working" | "awaiting_approval" | "error" | "cancelled"): string {
  switch (status) {
    case "working":
      return color.cyan(color.bold("Working"));
    case "awaiting_approval":
      return color.yellow("Waiting for approval");
    case "error":
      return color.red("Failed");
    case "cancelled":
      return color.gray("Cancelled");
    default:
      return color.gray("");
  }
}

function statusIconFor(status: "idle" | "working" | "awaiting_approval" | "error" | "cancelled"): string {
  switch (status) {
    case "working":
      return color.cyan("···");
    case "awaiting_approval":
      return color.yellow("⚠");
    case "error":
      return color.red("✗");
    case "cancelled":
      return color.gray("Cancelled");
    default:
      return color.gray("");
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

/** Composer rows plus the layout metadata needed to place the real cursor. */
interface ComposerRender {
  lines: string[];
  layout: ComposerTextLayout;
  viewport: { start: number; end: number };
}

/**
 * Build the Cavehound bottom composer with its left accent rail and
 * right-aligned context, returning the wrapped-text layout as well so
 * `composeFrame` does not have to re-wrap the draft.
 */

function renderComposer(
  composer: { text: string; cursor: number },
  width: number,
  agentName: string | undefined,
  agentMode: "idle" | "running" | "shell" | "plan" | "file-picker",
  usage: { inputTokens: number; outputTokens: number } | undefined,
  model: ModelInfo | undefined,
  maxInputRows: number,
): ComposerRender {
  const margin = 2;
  const innerWidth = Math.max(1, width - margin * 2);
  const rail = color.gray("▌");
  const pad = " ".repeat(margin);
  const lines: string[] = [];

  const placeholder = derivePlaceholder(composer, agentName, agentMode);
  const text = composer.text.length > 0 ? composer.text : placeholder;
  const textColor = composer.text.length > 0 ? color.white : color.gray;
  const textBudget = Math.max(1, innerWidth - 3);
  const layout = layoutComposerText(text, textBudget, composer.text.length > 0 ? composer.cursor : 0);
  const viewport = composerViewport(layout, maxInputRows);

  // Reserve the top row of the composer surface as a margin so the input sits one
  // row below the top edge instead of touching it.
  lines.push("");

  // Soft-wrap long drafts into the composer instead of letting text collide with
  // the right edge. Continuation rows align with the text after the rail.
  for (let index = viewport.start; index < viewport.end; index++) {
    const row = layout.rows[index] ?? "";
    const prefix = index === 0 ? `${pad}${rail} ` : "    ";
    lines.push(`${prefix}${textColor(row)}`);
  }

  // Line 2: token usage only, right-aligned. The provider/cwd label is gone.
  if (usage) {
    const usageText = color.gray(formatUsage(usage));
    const rightPad = Math.max(0, innerWidth - stringWidth(usageText) - 2);
    lines.push(`${pad}${rail}${" ".repeat(rightPad)}${usageText}`);
  }

  // Keep the active model on its own row below the input.
  if (model) {
    const suffix = model.autoApprove ? "  (auto-approve)" : "";
    const modelText = `${model.provider}/${model.model}${suffix}`;
    const prefix = `${pad}${rail} ${color.magenta("model:")}  `;
    const maxModelWidth = Math.max(1, width - stringWidth(stripAnsi(prefix)));
    const fitted = truncateWidth(modelText, maxModelWidth);
    lines.push(`${prefix}${color.white(fitted)}`);
  }

  // Keep the composer compact so it doesn't stretch the chat surface too far
  // toward the terminal bottom. One spacer keeps the footer visually separated
  // without creating an oversized dark/normal split.
  lines.push("");

  return { lines, layout, viewport };
}

/** Render just the composer lines. */
export function renderCavehoundComposer(
  composer: { text: string; cursor: number },
  width: number,
  agentName: string | undefined,
  agentMode: "idle" | "running" | "shell" | "plan" | "file-picker",
  usage?: { inputTokens: number; outputTokens: number },
  model?: ModelInfo,
  maxInputRows = 6,
): string[] {
  return renderComposer(
    composer,
    width,
    agentName,
    agentMode,
    usage,
    model,
    maxInputRows,
  ).lines;
}

/** Blank rows kept below the composer; the composer's padding replaces the gap. */
const COMPOSER_BOTTOM_GAP = 0;

/** Plain hint rendered below the composer, outside the input rail. */
const COMPOSER_FOOTER = "attach · commands · run";

interface OverlayRow {
  row: number;
  line: string;
}

/** Fit a line inside the modal, dropping styling only when it must be clipped. */
function fitOverlayLine(line: string, width: number): string {
  if (stringWidth(line) <= width) return line;
  return truncateWidth(stripAnsi(line), width);
}

/**
 * Render a centered, bordered command panel over the conversation body.
 * The composer and status strip stay visible below it.
 */
function renderOverlayRows(
  overlay: OverlayView,
  width: number,
  top: number,
  bottom: number,
): OverlayRow[] {
  const usableWidth = Math.max(1, width - 1);
  const margin = usableWidth >= 50 ? 8 : 4;
  const boxWidth = Math.max(12, Math.min(72, usableWidth - margin));
  const innerWidth = Math.max(1, boxWidth - 2);
  const contentWidth = Math.max(1, innerWidth - 2);
  const footerRows = overlay.footer ? 2 : 0;
  const available = Math.max(1, bottom - top);
  const maxBodyRows = Math.max(1, available - 2 - footerRows);

  let body = overlay.body;
  let highlighted = overlay.highlight;
  if (body.length > maxBodyRows) {
    const focus = highlighted ?? 0;
    const start = Math.max(0, Math.min(focus - maxBodyRows + 1, body.length - maxBodyRows));
    body = body.slice(start, start + maxBodyRows);
    if (highlighted !== undefined) highlighted -= start;
  }
  if (highlighted !== undefined && (highlighted < 0 || highlighted >= body.length)) {
    highlighted = undefined;
  }

  const label = truncateWidth(` ${overlay.title} `, innerWidth);
  const labelFill = Math.max(0, innerWidth - stringWidth(label));
  const boxLines: string[] = [
    `${color.gray("╭")}${color.bold(color.magenta(label))}${color.gray(`${"─".repeat(labelFill)}╮`)}`,
  ];

  for (let index = 0; index < body.length; index++) {
    const fitted = padToWidth(fitOverlayLine(body[index] ?? "", contentWidth), contentWidth);
    const content = index === highlighted ? color.inverse(fitted) : fitted;
    boxLines.push(`${color.gray("│")} ${content} ${color.gray("│")}`);
  }

  if (overlay.footer) {
    boxLines.push(`${color.gray("├")}${color.gray("─".repeat(innerWidth))}${color.gray("┤")}`);
    const footer = padToWidth(
      fitOverlayLine(overlay.footer, contentWidth),
      contentWidth,
    );
    boxLines.push(`${color.gray("│")} ${color.dim(footer)} ${color.gray("│")}`);
  }

  boxLines.push(`${color.gray("╰")}${color.gray("─".repeat(innerWidth))}${color.gray("╯")}`);

  const boxHeight = boxLines.length;
  let start = Math.min(
    top + Math.max(0, Math.floor((available - boxHeight) / 2)),
    Math.max(top, bottom - boxHeight),
  );
  if (start < top) start = top;

  const leftPad = Math.max(0, Math.floor((usableWidth - boxWidth) / 2));
  const rightPad = Math.max(0, usableWidth - boxWidth - leftPad);
  const left = leftPad > 0 ? chromeBackground(" ".repeat(leftPad)) : "";
  const right = rightPad > 0 ? chromeBackground(" ".repeat(rightPad)) : "";

  const rows: OverlayRow[] = [];
  for (let index = 0; index < boxLines.length; index++) {
    const row = start + index;
    if (row >= bottom) break;
    rows.push({
      row,
      line: `${left}${composerBackground(padToWidth(boxLines[index] ?? "", boxWidth))}${right}`,
    });
  }
  return rows;
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
  // Slightly more top breathing room keeps the transcript from feeling cramped
  // directly under the header while preserving the compact lower composer.
  const headerRows = showHeader && bordered ? 3 : 0;

  const statusLines = input.agentStatus ? renderStatusStrip(input.agentStatus, width) : [];
  const controlGapRows = 1;
  // Reserve the intentional blank row(s) before the controls, plus the status
  // strip and the final footer. This keeps the transcript body height balanced.
  const statusBlockRows = statusLines.length > 0 ? statusLines.length + controlGapRows * 2 : controlGapRows;
  const footerRows = 1;
  const composerFixedRows = 2 + (input.usage ? 1 : 0) + (input.model ? 1 : 0);
  const queueCapacity = input.queuedPrompts?.length
    ? Math.max(1, Math.min(4, height - headerRows - 1 - statusBlockRows - footerRows - composerFixedRows - 3))
    : 0;
  const queuedLines = renderQueuedPrompts(input.queuedPrompts ?? [], width, queueCapacity);
  const queueBlockRows = queuedLines.length > 0 ? queuedLines.length + 1 : 0;
  const maxInputRows = Math.max(
    1,
    height - headerRows - 1 - statusBlockRows - queueBlockRows - footerRows - composerFixedRows - 1,
  );
  const composerRender = renderComposer(
    input.composer,
    width,
    input.agentName,
    input.agentMode,
    input.usage,
    input.model,
    maxInputRows,
  );
  const composerLines = composerRender.lines;
  const composerLayout = composerRender.layout;
  const composerViewportRange = composerRender.viewport;

  // Reserve fixed chrome first, then spend whatever is left on the transcript
  // and the bottom gap. Shrinking the gap keeps small terminals usable.
  const fixedRows =
    headerRows + 1 + statusBlockRows + queueBlockRows + composerLines.length + footerRows;
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
  let visible = input.transcript.slice(start, end);

  if (scroll > 0) {
    // When scrolled up, keep content at the top of the chat area and show
    // the scrollback indicator on the first line.
    const label = ` ↓ ${scroll} line${scroll === 1 ? "" : "s"} below · [End] jump to latest `;
    visible[0] = color.dim(label);
    while (visible.length < bodyHeight) visible.push("");
  } else {
    // Following the latest: pad at the top only so new messages always
    // arrive at the bottom edge of the chat area.
    while (visible.length < bodyHeight) visible.unshift("");
  }

  if (input.showBrand && total === 0 && scroll === 0) {
    const wordmark = renderRetroWordmark(width - 2, bodyHeight);
    const top = Math.max(0, Math.floor((bodyHeight - wordmark.length) / 2));
    for (let index = 0; index < wordmark.length && top + index < visible.length; index++) {
      const line = wordmark[index] ?? "";
      const left = Math.max(0, Math.floor((width - 2 - stringWidth(line)) / 2));
      visible[top + index] = `${" ".repeat(left)}${line}`;
    }
  }

  // Tint the conversation body. Stop one column short of the right edge so
  // the painter's end-of-line erase cannot clip the last cell.
  const chatStart = lines.length;
  for (const line of visible) {
    const text = truncateWidth(` ${line}`, width - 1);
    lines.push(panelBackground(padToWidth(text, width - 1)));
  }
  const chatEnd = lines.length;

  // Keep queued prompts in fixed chrome, not in the scrollable conversation.
  if (queuedLines.length > 0) {
    lines.push("");
    lines.push(...queuedLines);
  }

  // Separate the conversation from the chat controls with a single gap.
  if (statusLines.length > 0) {
    lines.push("");
    lines.push(...statusLines);
  }
  lines.push("");

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

  if (input.overlay) {
    const framed = [...frame];
    for (const { row, line } of renderOverlayRows(input.overlay, width, chatStart, chatEnd)) {
      if (row >= 0 && row < framed.length) framed[row] = line;
    }
    return { lines: framed, bodyHeight };
  }

  const cursorRow = composerStartRow + 1 + composerLayout.cursorRow - composerViewportRange.start;
  const cursorCol = clamp(4 + composerLayout.cursorColumn, 0, Math.max(0, width - 4));
  return {
    lines: frame,
    bodyHeight,
    cursor: {
      row: clamp(cursorRow, 0, height - 1),
      col: clamp(cursorCol, 0, width - 1),
    },
  };
}
