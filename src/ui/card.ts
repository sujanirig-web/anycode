import { color } from "../util/ansi.js";
import { padToWidth, stringWidth, stripAnsi, truncateWidth } from "../util/width.js";
import { wrapText } from "../util/wrap.js";
import type { ActivityCard, Step, StepStatus } from "./activity.js";

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
  running: color.gray,
  ok: color.gray,
  warning: color.yellow,
  error: color.red,
};

const STATUS_BORDER: Record<StepStatus, (s: string) => string> = {
  running: color.gray,
  ok: color.gray,
  warning: color.yellow,
  error: color.red,
};

const MAX_DETAIL_LINES = 12;
const MAX_PERMISSION_LINES = 6;

function cardTitle(card: ActivityCard): string {
  const marker = card.expanded ? "▾" : "▸";
  const count = card.steps.length;
  const failed = card.steps.filter((step) => step.status === "error").length;
  const interrupted = card.steps.filter((step) => step.status === "warning").length;
  const parts = [`${count} step${count === 1 ? "" : "s"}`];
  if (failed > 0) parts.push(`${failed} failed`);
  else if (interrupted > 0) parts.push(`${interrupted} interrupted`);
  return `${marker} ${card.intent} · ${parts.join(" · ")}`;
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
  let line = `${treePrefix}${icon} ${color.gray(name)}  ${color.dim(summary)}`;
  if (timing.length > 0) line += color.gray(timing);
  if (selected) line = color.inverse(line);
  return line;
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
): string[] {
  // Guard: never render an empty card
  if (!card.steps || card.steps.length === 0) return [];

  const totalWidth = Math.max(10, width);
  const contentWidth = totalWidth - 2;
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

/**
 * Status border color for a card - no blue, no dim blue.
 */
export function statusBorderColor(status: StepStatus): (s: string) => string {
  return STATUS_BORDER[status];
}
