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
  /** Already-styled transcript lines. */
  transcript: string[];
  /** Lines scrolled up from the bottom (0 = follow the tail). */
  scroll: number;
  statusLeft: string;
  statusRight: string;
  composer: { text: string; cursor: number };
  approval?: ApprovalView;
  footer: string;
}

export interface Frame {
  lines: string[];
  cursor?: { row: number; col: number };
  /** Transcript rows available in this frame (for page scrolling). */
  bodyHeight: number;
}

const MIN_WIDTH = 20;
const MIN_HEIGHT = 6;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function headerLine(left: string, right: string, width: number): string {
  const rightText = truncateWidth(right, Math.max(0, width - 14));
  const available = Math.max(0, width - stringWidth(rightText) - 2);
  const leftText = padToWidth(truncateWidth(left, available), available);
  return color.bold(color.cyan(truncateWidth(`${leftText} ${rightText} `, width)));
}

function sideBySide(left: string, right: string, width: number): string {
  const rightText = truncateWidth(right, Math.max(0, width - 10));
  const available = Math.max(0, width - stringWidth(rightText) - 2);
  const leftText = truncateWidth(left, available);
  const gap = Math.max(1, width - stringWidth(leftText) - stringWidth(rightText) - 2);
  return ` ${leftText}${" ".repeat(gap)}${rightText} `;
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
  if (bordered) lines.push(color.dim(`${top}${"─".repeat(innerWidth)}${bottom}`));
  for (const line of inner) {
    if (bordered) {
      lines.push(`${color.dim("│")}${padToWidth(truncateWidth(line, innerWidth), innerWidth)}${color.dim("│")}`);
    } else {
      lines.push(truncateWidth(line, width));
    }
  }
  if (bordered) lines.push(color.dim(`╰${"─".repeat(innerWidth)}╯`));
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

  const bordered = width >= 34 && height >= 12;
  const footerRows = bordered ? 1 : 0;
  const statusRows = bordered ? 1 : 0;
  const borderRows = bordered ? 2 : 0;
  const dividerRows = bordered ? 1 : 0;

  const maxInputRows = Math.max(1, bordered ? height - 8 : 3);
  const textWidth = bordered ? width - 5 : width - 2;
  const prefix = bordered ? " › " : "› ";
  const continuation = "   ";

  const approvalDetail = input.approval?.detail
    ? input.approval.detail.split(/\r?\n/).slice(0, maxInputRows)
    : [];

  const composer = input.approval
    ? {
        rows: (approvalDetail.length > 0 ? approvalDetail : ["(no details)"]).map((line) =>
          `   ${color.dim(truncateWidth(line, width - 6))}`,
        ),
        cursorRow: 0,
        cursorCol: 0,
      }
    : layoutComposer(input.composer, textWidth, maxInputRows, prefix, continuation);

  const inputRows = composer.rows.length;
  const composerHeight = inputRows + borderRows;
  const bodyTop = bordered ? 2 : 1;
  let bodyHeight = height - bodyTop - composerHeight - statusRows - footerRows - dividerRows;

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
  lines.push(headerLine(input.headerLeft, input.headerRight, width));
  if (bordered) lines.push("");

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
      color.bold(color.gray(sideBySide(input.approval ? `⚠ ${input.approval.title}` : input.statusLeft, input.statusRight, width))),
    );
  }

  const boxed = boxLines(composer.rows, width, "╭", "╮", bordered);
  // Thin divider between transcript body and the composer input area.
  if (bordered) lines.push(color.dim("├" + "─".repeat(width - 2) + "┤"));
  lines.push(...boxed);

  if (effectiveFooter > 0) lines.push(color.dim(truncateWidth(` ${input.footer}`, width)));

  while (lines.length < height) lines.push("");
  const frame = lines.slice(0, height);

  if (input.approval) return { lines: frame, bodyHeight };

  const cursorRow =
    bodyTop + bodyHeight + effectiveStatus + (bordered ? 2 : 1) + composer.cursorRow;
  const cursorCol = (bordered ? 1 : 0) + composer.cursorCol;
  return {
    lines: frame,
    bodyHeight,
    cursor: {
      row: clamp(cursorRow, 0, height - 1),
      col: clamp(cursorCol, 0, width - 1),
    },
  };
}
