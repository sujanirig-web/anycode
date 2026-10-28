import { color } from "../util/ansi.js";
import { padToWidth, stringWidth, truncateWidth } from "../util/width.js";
import { wrapText } from "../util/wrap.js";
import type { ActivityCard, Step } from "./activity.js";

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
const TITLE_COLOR = color.bold;
const INTENT_COLOR = color.cyan;

/**
 * Render a single activity card as lines with tree structure.
 * Returns lines without the outer border padding (caller adds border).
 */
export function renderCard(
  card: ActivityCard,
  width: number,
  selectedStepIndex: number | undefined = undefined,
): string[] {
  const innerWidth = Math.max(10, width - 4);
  const lines: string[] = [];

  // Header line: status icon + intent + step count + duration
  const lastStep = card.steps[card.steps.length - 1];
  const duration = lastStep?.durationMs !== undefined ? ` · ${lastStep.durationMs}ms` : "";
  const stepCount = card.steps.length > 0 ? ` · ${card.steps.length} step${card.steps.length === 1 ? "" : "s"}` : "";
  const icon = TREE_COLORS[card.status](TREE_ICONS[card.status]);
  const title = `${INTENT_COLOR(card.intent)}${color.gray(stepCount + duration)}`;
  const headerPadding = "─".repeat(Math.max(1, innerWidth - stringWidth(icon + " " + card.intent + stepCount + duration) - 1));
  lines.push(`${icon} ${card.intent}${color.gray(stepCount + duration)} ${color.gray(headerPadding)}`);

  if (!card.expanded) {
    return lines;
  }

  // Blank line
  lines.push("");

  // Steps
  for (let i = 0; i < card.steps.length; i++) {
    const step = card.steps[i]!;
    const isLast = i === card.steps.length - 1;
    const treePrefix = isLast ? "└─ " : "├─ ";
    const icon = TREE_COLORS[step.status](TREE_ICONS[step.status]);
    const name = color.cyan(step.tool);
    const detail = color.dim(step.summary);
    const timing = step.durationMs !== undefined && step.status !== "running"
      ? `  ${color.gray(`(${step.durationMs}ms)`)}`
      : "";
    let stepLine = `${treePrefix}${icon} ${name}  ${detail}${timing}`;
    stepLine = truncateWidth(stepLine, innerWidth - 2);

    // Highlight selected step
    if (selectedStepIndex !== undefined && i === selectedStepIndex) {
      stepLine = color.inverse(stepLine);
    }
    lines.push(stepLine);

    // Detail line (command or output preview) for non-collapsed important steps
    if (step.detail && (step.status === "warning" || step.status === "error" || selectedStepIndex === i)) {
      const detailLines = wrapText(step.detail, innerWidth - 6);
      for (const dl of detailLines) {
        lines.push(`   ${color.dim(dl)}`);
      }
    }
  }

  // Permission prompt inline
  if (card.permission) {
    lines.push("");
    lines.push(color.bold(color.yellow("⚠  ")) + color.bold(`${card.permission.tool} needs approval`));
    if (card.permission.command) {
      lines.push(`  ${color.dim("Command:")} ${truncateWidth(card.permission.command, innerWidth - 4)}`);
    }
    if (card.permission.cwd) {
      lines.push(`  ${color.dim("Directory:")} ${color.gray(card.permission.cwd)}`);
    }
    if (card.permission.risk) {
      lines.push(`  ${color.dim("Risk:")} ${color.yellow(card.permission.risk)}`);
    }
    lines.push("");
    lines.push(`  ${color.yellow("[y]")} ${color.white("Run once   ")}
${color.yellow("[a]")} ${color.white("Always allow   ")}
${color.yellow("[n]")} ${color.white("Cancel")}`);
    lines.push("");
    lines.push(`  ${color.yellow("[e]")} ${color.white("Expand details   ")}
${color.yellow("[o]")} ${color.white("Open output")}`);
  }

  return lines;
}

/**
 * Render a card inside a bordered box panel.
 * Returns the full bordered panel lines.
 */
export function renderCardPanel(
  card: ActivityCard,
  width: number,
  selectedStepIndex: number | undefined = undefined,
): string[] {
  const innerWidth = Math.max(10, width - 4);
  const cardLines = renderCard(card, innerWidth, selectedStepIndex);

  const lines: string[] = [];
  const borderLeft = color.blue("│");
  const borderRight = color.blue("│");

  const topPad = Math.max(1, innerWidth - stringWidth(card.intent) - 4);
  const top = `┌─ ${color.bold(card.intent)} ${color.gray("─".repeat(topPad))}`;
  lines.push(color.blue(top));

  for (const line of cardLines) {
    const padding = " ".repeat(Math.max(0, innerWidth - stringWidth(line)));
    lines.push(`${borderLeft} ${line}${padding}${borderRight}`);
  }

  const bottom = `└${"─".repeat(innerWidth + 2)}`;
  lines.push(color.blue(bottom));

  return lines;
}
