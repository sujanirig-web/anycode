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
  headerLeft: string;
  headerRight: string;
  /** Hide the top header bar (version + provider/model). */
  showHeader?: boolean;
  /** Already-styled transcript lines. */
  transcript: string[];
  /** Lines scrolled up from the bottom (0 = follow the tail). */
  scroll: number;
  statusLeft: string;
  statusRight: string;
  composer: { text: string; cursor: number };
  approval?: ApprovalView;
  footer: string;
  /** Token usage for compact display in composer context row. */
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Frame {
  lines: string[];
  cursor?: { row: number; col: number };
  /** Transcript rows available in this frame (for page scrolling). */
  bodyHeight: number;
}

const MIN_WIDTH = 20;
const MIN_HEIGHT = 6;

/** Render the Cavehound bottom composer with left accent rail and right-aligned context. */
function renderCavehoundComposer(
  composer: { text: string; cursor: number },
  width: number,
  mode: "idle" | "typing" | "working",
  usage?: { inputTokens: number; outputTokens: number },
): string[] {
  const innerWidth = Math.max(1, width - 4);
  const rail = color.gray("▌");
  const lines: string[] = [];

  const placeholder = "ask cavehound";
  const text = composer.text.length > 0 ? composer.text : placeholder;
  const textColor = composer.text.length > 0 ? color.white : color.gray;
  const cursorCol = Math.min(composer.cursor, text.length);
  const visibleText = truncateWidth(text, innerWidth - 2);

  // Line 1: rail + placeholder/input
  lines.push(`${rail} ${textColor(visibleText)}`);

  // Line 2: rail + hint row
  if (mode === "working") {
    lines.push(`${rail} ${color.dim("Tab queue · Esc interrupt")}`);
  } else {
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function headerLine(left: string, right: string, width: number): string {
  const rightText = truncateWidth(right, Math.max(0, width - 14));
  const available = Math.max(0, width - stringWidth(rightText) - 2);
  const leftText = padToWidth(truncateWidth(left, available), available);
  return color.bold(color.magenta(truncateWidth(`${leftText} ${rightText} `, width)));
}

/** Format token usage compactly: under 1k shows raw, 1k+ uses k suffix. */
function formatUsage(usage: { inputTokens: number; outputTokens: number }): string {
  const fmt = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `${fmt(usage.inputTokens)} in · ${fmt(usage.outputTokens)} out`;
}

function sideBySide(left: string, right: string, width: number): string {
  const rightText = truncateWidth(right, Math.max(0, width - 10));
  const available = Math.max(0, width - stringWidth(rightText) - 2);
  const leftText = truncateWidth(left, available);
  const gap = Math.max(1, width - stringWidth(leftText) - stringWidth(rightText) - 2);
  return ` ${leftText}${" ".repeat(gap)}${rightText} `;
}

/** Render an approval panel inside the composer box: title, detail, hint. */
function renderApprovalPanel(
  approval: ApprovalView,
  width: number,
  maxRows: number,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const lines: string[] = [];
  const title = truncateWidth(approval.title, innerWidth);
  const hint = color.yellow("  [y]es  [n]o  [a]lways");
  lines.push(`${color.bold(color.red("⚠ "))}${color.bold(title)}${hint}`);
  if (approval.detail) {
    for (const line of approval.detail.split(/\r?\n/).slice(0, maxRows - 1)) {
      lines.push(`   ${color.dim(truncateWidth(line, innerWidth - 3))}`);
    }
  }
  while (lines.length < maxRows) lines.push("");
  return lines;
}

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

function boxLines(
  inner: string[],
  width: number,
  top: string,
  bottom: string,
  bordered: boolean,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const lines: string[] = [];
  if (bordered) lines.push(color.blue(`${top}${"─".repeat(innerWidth)}${bottom}`));
  for (const line of inner) {
    if (bordered) {
      lines.push(`${color.blue("│")}${padToWidth(truncateWidth(line, innerWidth), innerWidth)}${color.blue("│")}`);
    } else {
      lines.push(truncateWidth(line, width));
    }
  }
  if (bordered) lines.push(color.blue(`╰${"─".repeat(innerWidth)}╯`));
  return lines;
}

/**
 * Compose a full-screen frame: header, scrollable transcript, status line,
 * composer box and footer. Pure and deterministic so it can be tested without a
 * terminal.
 */
export function composeFrame(input: FrameInput): Frame {
  const width = Math.max(MIN_WIDTH, Math.floor(input.width));
  const height = Math.max(MIN_HEIGHT, Math.floor(input.height));

  const showHeader = input.showHeader !== false;
  const bordered = width >= 34 && height >= 12;
  const headerRows = showHeader && bordered ? 2 : 0; // header line + blank spacer
  const footerRows = bordered ? 1 : 0;
  const statusRows = bordered ? 1 : 0;
  const borderRows = bordered ? 2 : 0;
  const dividerRows = bordered ? 1 : 0;

  const maxInputRows = Math.max(1, bordered ? height - 8 : 3);
  const textWidth = bordered ? width - 5 : width - 2;
  const prefix = bordered ? color.green(" › ") : color.green("› ");
  const continuation = "   ";

  const composer = layoutComposer(input.composer, textWidth, maxInputRows, prefix, continuation);

  const inputRows = composer.rows.length;
  const composerHeight = inputRows + borderRows;
  const bodyTop = bordered ? (showHeader ? 2 : 0) : 0;
  let bodyHeight = height - bodyTop - composerHeight - statusRows - footerRows - dividerRows - headerRows;

  // Very short terminals: drop the status/footer before dropping transcript rows.
  let effectiveStatus = statusRows;
  let effectiveFooter = footerRows;
  if (bodyHeight < 2 && effectiveFooter > 0) {
    effectiveFooter = 0;
    bodyHeight += 1;
  }
  if (bodyHeight < 2 && effectiveStatus > 0) {
    effectiveStatus = 0;
    bodyHeight += 1;
  }
  if (bodyHeight < 1) {
    bodyHeight = 1;
  }

  const lines: string[] = [];
  if (showHeader && bordered) {
    lines.push(headerLine(input.headerLeft, input.headerRight, width));
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

  if (effectiveStatus > 0) {
    lines.push(
      color.bold(color.gray(sideBySide(input.approval ? "⚠ approval pending" : input.statusLeft, input.statusRight, width))),
    );
  }

  const composerLines = renderCavehoundComposer(
    input.composer,
    input.width,
    input.approval ? "working" : input.composer.text.length > 0 ? "typing" : "idle",
    input.usage,
  );
  lines.push(...composerLines);

  if (effectiveFooter > 0) lines.push(color.gray(truncateWidth(` ${input.footer}`, width)));

  while (lines.length < height) lines.push("");
  const frame = lines.slice(0, height);

  if (input.approval) return { lines: frame, bodyHeight };

  const composerStartRow = bodyTop + bodyHeight + effectiveStatus;
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
