import { color } from "../util/ansi.js";
import { stringWidth, truncateWidth } from "../util/width.js";
import { wrapText } from "../util/wrap.js";
import type { ActivityCard, Step, StepStatus } from "./activity.js";

const TREE_ICONS = {
  running: "⋯",
  ok: "✓",
  warning: "⚠",
  error: "✗",
};

const TREE_COLORS = {
  running: color.blue,
  ok: color.green,
  warning: color.yellow,
  error: color.red,
};

const BORDER_COLOR = color.gray;

const STATUS_BORDER: Record<StepStatus, (s: string) => string> = {
  running: color.gray,
  ok: color.gray,
  warning: color.yellow,
  error: color.red,
};

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
): string[] {
  // Guard: never render an empty card
  if (!card.steps || card.steps.length === 0) return [];

  const innerWidth = Math.max(10, width - 4);
  const lines: string[] = [];
  const borderLeft = BORDER_COLOR("│");
  const borderRight = BORDER_COLOR("│");

  // Determine border color based on status
  const statusColor = STATUS_BORDER[card.status];
  const borderLeftC = statusColor("│");
  const borderRightC = statusColor("│");

  // Top border: ┌─ intent ─────────
  const title = truncateWidth(card.intent, innerWidth - 4);
  const titlePad = Math.max(1, innerWidth - stringWidth(title) - 4);
  lines.push(`${statusColor("┌─")} ${statusColor(title)} ${statusColor("─".repeat(titlePad))}`);

  if (!card.expanded) {
    const bottom = `${statusColor("└")}${statusColor("─".repeat(innerWidth + 2))}`;
    lines.push(bottom);
    return lines;
  }

  // Blank line
  lines.push(`${borderLeftC}  ${borderRightC}`);

  // Steps as tree lines
  for (let i = 0; i < card.steps.length; i++) {
    const step = card.steps[i]!;
    const isLast = i === card.steps.length - 1;
    const treePrefix = isLast ? "└─ " : "├─ ";
    const icon = TREE_COLORS[step.status](TREE_ICONS[step.status]);
    const name = color.cyan(step.tool);
    const detail = color.dim(step.summary);
    const timing =
      step.durationMs !== undefined && step.status !== "running"
        ? `  ${color.gray(`(${step.durationMs}ms)`)}`
        : "";
    let stepLine = `  ${treePrefix}${icon} ${name}  ${detail}${timing}`;
    stepLine = truncateWidth(stepLine, innerWidth - 2);

    if (selectedStepIndex !== undefined && i === selectedStepIndex) {
      stepLine = color.inverse(stepLine);
    }
    const padding = " ".repeat(Math.max(0, innerWidth - stringWidth(stepLine)));
    lines.push(`${borderLeftC} ${stepLine}${padding}${borderRightC}`);

    // Detail line for warning/error/selected steps
    if (
      step.detail &&
      (step.status === "warning" || step.status === "error" || selectedStepIndex === i)
    ) {
      const detailLines = wrapText(step.detail, innerWidth - 6);
      for (const dl of detailLines) {
        const padded = `    ${color.dim(dl)}`;
        const dPadding = " ".repeat(Math.max(0, innerWidth - stringWidth(padded)));
        lines.push(`${borderLeftC} ${padded}${dPadding}${borderRightC}`);
      }
    }
  }

  // Permission prompt inline inside the card
  if (card.permission) {
    lines.push(`${borderLeftC}  ${borderRightC}`);
    lines.push(
      `${borderLeftC}  ${statusColor("⚠")} ${color.bold(card.permission.tool)} needs approval${borderRightC}`,
    );
    if (card.permission.explanation) {
      const expLines = wrapText(card.permission.explanation, innerWidth - 6);
      for (const el of expLines) {
        const padded = `  ${el}`;
        const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(padded)));
        lines.push(`${borderLeftC} ${padded}${pad}${borderRightC}`);
      }
    }
    if (card.permission.reason) {
      const reasonLines = wrapText(card.permission.reason, innerWidth - 6);
      for (const rl of reasonLines) {
        const padded = `  ${rl}`;
        const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(padded)));
        lines.push(`${borderLeftC} ${padded}${pad}${borderRightC}`);
      }
    }
    if (card.permission.primaryCommand) {
      const cmdLine = `  ${color.dim("Command:")} ${truncateWidth(card.permission.primaryCommand, innerWidth - 8)}`;
      const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(cmdLine)));
      lines.push(`${borderLeftC} ${cmdLine}${pad}${borderRightC}`);
    }
    if (card.permission.risk) {
      const riskColor =
        card.permission.riskLevel === "HIGH" ? color.red : card.permission.riskLevel === "MEDIUM" ? color.yellow : color.green;
      const riskLine = `  ${color.dim("Risk:")} ${riskColor(card.permission.riskLevel)} · ${color.dim(card.permission.risk)}`;
      const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(riskLine)));
      lines.push(`${borderLeftC} ${riskLine}${pad}${borderRightC}`);
    }
    lines.push(`${borderLeftC}  ${borderRightC}`);
    lines.push(
      `${borderLeftC}  ${color.yellow("[y]")} ${color.white("run once   ")}${color.yellow("[a]")} ${color.white("always   ")}${color.yellow("[n]")} ${color.white("cancel")}${borderRightC}`,
    );
    lines.push(`${borderLeftC}  ${borderRightC}`);
    lines.push(
      `${borderLeftC}  ${color.yellow("[v]")} ${color.white("full command   ")}${color.yellow("[o]")} ${color.white("output")}${borderRightC}`,
    );
  }

  // Bottom border
  const bottom = `${statusColor("└")}${statusColor("─".repeat(innerWidth + 2))}`;
  lines.push(bottom);

  return lines;
}

/**
 * Status border color for a card - no blue, no dim blue.
 */
export function statusBorderColor(status: StepStatus): (s: string) => string {
  return STATUS_BORDER[status];
}
