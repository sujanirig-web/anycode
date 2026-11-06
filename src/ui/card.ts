import { color } from "../util/ansi.js";
import { padToWidth, stringWidth, stripAnsi, truncateWidth } from "../util/width.js";
import { wrapText } from "../util/wrap.js";
import type { ActivityCard, Step, StepStatus } from "./activity.js";
import type { FileChange } from "../tools/types.js";
import { changeTone, summarizeFileChange } from "./renderer.js";

const TREE_ICONS = {
  running: "⋯",
  ok: "✓",
  warning: "⚠",
  error: "✗",
};

/**
 * Animated running glyph: a single block bar that rises and falls, so the
 * tool line stays the same width while it looks like a tiny wave.
 */
const RUNNING_WAVE = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂"];

function runningGlyph(nowMs: number | undefined): string {
  if (nowMs === undefined) return TREE_ICONS.running;
  const index = Math.floor(nowMs / 90) % RUNNING_WAVE.length;
  return RUNNING_WAVE[index] ?? TREE_ICONS.running;
}

const TREE_COLORS = {
  running: color.cyan,
  ok: color.green,
  warning: color.yellow,
  error: color.red,
};

const STATUS_BORDER: Record<StepStatus, (s: string) => string> = {
  running: color.cyan,
  ok: color.green,
  warning: color.yellow,
  error: color.red,
};

const MAX_DETAIL_LINES = 12;
const MAX_PERMISSION_LINES = 6;
const MAX_CHANGE_SUMMARY_LINES = 6;
const MAX_LIVE_DIFF_LINES = 12;
const MAX_EXPANDED_DIFF_LINES = 40;

function cardTitle(card: ActivityCard): string {
  const marker = card.expanded ? "▾" : "▸";
  const count = card.steps.length;
  let failed = 0;
  let interrupted = 0;
  for (const step of card.steps) {
    if (step.status === "error") failed++;
    else if (step.status === "warning") interrupted++;
  }
  const files = card.changes?.length ?? 0;
  const parts = [`${count} step${count === 1 ? "" : "s"}`];
  if (failed > 0) parts.push(`${failed} failed`);
  else if (interrupted > 0) parts.push(`${interrupted} interrupted`);
  if (files > 0) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  return `${marker} ${card.intent} · ${parts.join(" · ")}`;
}

/** Compact list of files changed while the card was active. */
function changeSummaryLines(changes: FileChange[], contentWidth: number): string[] {
  if (changes.length === 0) return [];
  const lines = [""];
  const shown = changes.slice(0, MAX_CHANGE_SUMMARY_LINES);
  for (const change of shown) {
    lines.push(
      ` ${changeTone(change)("✎")} ${summarizeFileChange(change, contentWidth - 4)}`,
    );
  }
  if (changes.length > shown.length) {
    lines.push(`   ${color.dim(`… ${changes.length - shown.length} more files`)}`);
  }
  return lines;
}

/** Color a single diff line, keeping the box gutter aligned. */
function diffLine(line: string, width: number): string {
  const clipped = truncateWidth(line, Math.max(1, width));
  if (clipped.startsWith("@@")) return color.cyan(clipped);
  if (clipped.startsWith("+")) return color.green(clipped);
  if (clipped.startsWith("-")) return color.red(clipped);
  return color.dim(clipped);
}

function stepLine(
  step: Step,
  index: number,
  total: number,
  contentWidth: number,
  selected: boolean,
  nowMs: number | undefined,
): string {
  const isLast = index === total - 1;
  const treePrefix = isLast ? "└─ " : "├─ ";
  const glyph = step.status === "running" ? runningGlyph(nowMs) : TREE_ICONS[step.status];
  const icon = TREE_COLORS[step.status](glyph);
  const name = truncateWidth(step.tool, 18);
  const timing =
    step.durationMs !== undefined && step.status !== "running"
      ? `  (${(step.durationMs / 1000).toFixed(1)}s)`
      : "";
  const plainPrefix = `${treePrefix}${glyph} `;
  const available = contentWidth - 2 - stringWidth(plainPrefix) - stringWidth(name) - 2 - stringWidth(timing);
  const summary = truncateWidth(step.summary, Math.max(0, available));
  let line = `${treePrefix}${icon} ${color.cyan(name)}  ${color.dim(summary)}`;
  if (timing.length > 0) line += color.gray(timing);
  if (selected) line = color.inverse(line);
  return line;
}

/** Truncated, colored diff excerpts for every file changed in the box. */
function changeDiffLines(card: ActivityCard, contentWidth: number, expand: boolean): string[] {
  const out: string[] = [];
  let budget = expand ? MAX_EXPANDED_DIFF_LINES : MAX_LIVE_DIFF_LINES;

  for (const change of card.changes ?? []) {
    if (!change.diff || budget <= 0) continue;
    const diffLines = change.diff.split(/\r?\n/);
    const shown = diffLines.slice(0, budget);
    for (const line of shown) {
      out.push(`      ${diffLine(line, Math.max(1, contentWidth - 6))}`);
    }
    budget -= shown.length;
    if (diffLines.length > shown.length) {
      const remaining = diffLines.length - shown.length;
      out.push(
        `      ${color.dim(
          `… ${remaining} more ${remaining === 1 ? "line" : "lines"}${expand ? "" : " (Ctrl+O to expand)"}`,
        )}`,
      );
    }
  }

  return out;
}

/**
 * Render a single activity card as a bordered panel with tree steps.
 * Card width = width param (already computed as terminalWidth - margins).
 * Never nested inside another panel.
 * No blue or dim blue used in activity cards.
 */
export function renderCardPanel(
  card: ActivityCard,
  width: number,
  selectedStepIndex: number | undefined = undefined,
  nowMs?: number,
  expandDiffs = false,
): string[] {
  // Guard: never render an empty card
  if (card.steps.length === 0 && (card.changes?.length ?? 0) === 0) return [];

  const totalWidth = Math.max(10, width);
  const contentWidth = totalWidth - 2;
  const changes = card.changes ?? [];
  const statusColor = STATUS_BORDER[card.status];
  const border = statusColor("│");
  const body = (text: string): string => {
    const clipped =
      stringWidth(text) <= contentWidth
        ? text
        : truncateWidth(stripAnsi(text), contentWidth);
    return `${border}${padToWidth(clipped, contentWidth)}${border}`;
  };

  const lines: string[] = [];
  const title = truncateWidth(cardTitle(card), Math.max(1, totalWidth - 6));
  const fill = Math.max(1, totalWidth - 5 - stringWidth(title));
  lines.push(
    `${statusColor("┌─")} ${statusColor(title)} ${statusColor("─".repeat(fill))}${statusColor("┐")}`,
  );

  if (!card.expanded) {
    // A finished box keeps a compact list of what changed, then offers the
    // full diffs through the global expand toggle.
    if (changes.length > 0) {
      for (const line of changeSummaryLines(changes, contentWidth)) lines.push(body(line));
      if (expandDiffs) {
        for (const line of changeDiffLines(card, contentWidth, true)) lines.push(body(line));
      } else {
        lines.push(body(`   ${color.dim("Ctrl+O to show the code · Alt+e to open this box")}`));
      }
    }
    lines.push(`${statusColor("└")}${statusColor("─".repeat(contentWidth))}${statusColor("┘")}`);
    return lines;
  }

  // Breathing room between the title and the first step.
  lines.push(body(""));

  for (let index = 0; index < card.steps.length; index++) {
    const step = card.steps[index]!;
    const selected = selectedStepIndex === index;
    lines.push(body(` ${stepLine(step, index, card.steps.length, contentWidth, selected, nowMs)}`));

    if (step.detail && (step.status === "warning" || step.status === "error" || selected)) {
      const detailLines = wrapText(step.detail, Math.max(1, contentWidth - 6));
      const shown = detailLines.slice(0, MAX_DETAIL_LINES);
      for (const detail of shown) {
        lines.push(body(`    ${color.dim(detail)}`));
      }
      if (detailLines.length > shown.length) {
        lines.push(
          body(`    ${color.dim(`… ${detailLines.length - shown.length} more lines`)}`),
        );
      }
    }
  }

  if (changes.length > 0) {
    for (const line of changeSummaryLines(changes, contentWidth)) lines.push(body(line));
    for (const line of changeDiffLines(card, contentWidth, expandDiffs)) lines.push(body(line));
  }

  if (card.permission) {
    lines.push(body(""));
    lines.push(
      body(`  ${statusColor("⚠")} ${color.bold(card.permission.tool)} needs approval`),
    );

    const wrapPermission = (text: string): string[] =>
      wrapText(text, Math.max(1, contentWidth - 4)).slice(0, MAX_PERMISSION_LINES);

    for (const explanation of wrapPermission(card.permission.explanation)) {
      lines.push(body(`  ${explanation}`));
    }
    for (const reason of wrapPermission(card.permission.reason)) {
      lines.push(body(`  ${reason}`));
    }

    if (card.permission.primaryCommand) {
      lines.push(
        body(
          `  ${color.dim("Command:")} ${truncateWidth(card.permission.primaryCommand, Math.max(1, contentWidth - 12))}`,
        ),
      );
    }
    if (card.permission.risk) {
      const riskColor =
        card.permission.riskLevel === "HIGH"
          ? color.red
          : card.permission.riskLevel === "MEDIUM"
            ? color.yellow
            : color.green;
      lines.push(
        body(
          `  ${color.dim("Risk:")} ${riskColor(card.permission.riskLevel)} · ${color.dim(card.permission.risk)}`,
        ),
      );
    }

    lines.push(body(""));
    lines.push(
      body(
        `  ${color.yellow("[y]")} ${color.white("run once   ")}${color.yellow("[a]")} ${color.white("always   ")}${color.yellow("[n]")} ${color.white("cancel")}`,
      ),
    );
    lines.push(body(""));
    lines.push(
      body(
        `  ${color.yellow("[v]")} ${color.white("full command   ")}${color.yellow("[o]")} ${color.white("output")}`,
      ),
    );
  }

  lines.push(`${statusColor("└")}${statusColor("─".repeat(contentWidth))}${statusColor("┘")}`);

  return lines;
}
