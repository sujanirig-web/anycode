import { color } from "../util/ansi.js";
import { stringWidth, truncateWidth } from "../util/width.js";
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

/**
 * Render a single activity card as a bordered panel with tree steps.
 * Card width = width param (already computed as terminalWidth - margins).
 * Never nested inside another panel.
 */
export function renderCardPanel(
  card: ActivityCard,
  width: number,
  selectedStepIndex: number | undefined = undefined,
): string[] {
  // Guard: never render an empty card (no tool steps)
  if (!card.steps || card.steps.length === 0) return [];

  const innerWidth = Math.max(10, width - 4); // minus left/right border + padding
  const lines: string[] = [];
  const borderLeft = BORDER_COLOR("│");
  const borderRight = BORDER_COLOR("│");

  // Top border: ┌─ intent ─────────
  const title = truncateWidth(card.intent, innerWidth - 4);
  const titlePad = "─".repeat(Math.max(1, innerWidth - stringWidth(title) - 4));
  lines.push(`${BORDER_COLOR("┌─")} ${BORDER_COLOR(title)} ${BORDER_COLOR(titlePad)}`);

  if (!card.expanded) {
    const bottom = `${BORDER_COLOR("└")}${BORDER_COLOR("─".repeat(innerWidth + 2))}`;
    lines.push(bottom);
    return lines;
  }

  // Blank line
  lines.push(`${borderLeft}  ${borderRight}`);

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
    lines.push(`${borderLeft} ${stepLine}${padding}${borderRight}`);

    // Detail line for warning/error/selected steps
    if (
      step.detail &&
      (step.status === "warning" || step.status === "error" || selectedStepIndex === i)
    ) {
      const detailLines = wrapText(step.detail, innerWidth - 6);
      for (const dl of detailLines) {
        const padded = `    ${color.dim(dl)}`;
        const dPadding = " ".repeat(Math.max(0, innerWidth - stringWidth(padded)));
        lines.push(`${borderLeft} ${padded}${dPadding}${borderRight}`);
      }
    }
  }

  // Permission prompt inline inside the card
  if (card.permission) {
    lines.push(`${borderLeft}  ${borderRight}`);
    lines.push(
      `${borderLeft}  ${color.bold(color.yellow("⚠"))} ${color.bold(`${card.permission.tool} needs approval`)}${borderRight}`,
    );
    if (card.permission.command) {
      const cmdLine = `  ${color.dim("Command:")} ${truncateWidth(card.permission.command, innerWidth - 6)}`;
      const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(cmdLine)));
      lines.push(`${borderLeft} ${cmdLine}${pad}${borderRight}`);
    }
    if (card.permission.cwd) {
      const cwdLine = `  ${color.dim("Directory:")} ${color.gray(card.permission.cwd)}`;
      const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(cwdLine)));
      lines.push(`${borderLeft} ${cwdLine}${pad}${borderRight}`);
    }
    if (card.permission.risk) {
      const riskLine = `  ${color.dim("Risk:")} ${color.yellow(card.permission.risk)}`;
      const pad = " ".repeat(Math.max(0, innerWidth - stringWidth(riskLine)));
      lines.push(`${borderLeft} ${riskLine}${pad}${borderRight}`);
    }
    lines.push(`${borderLeft}  ${borderRight}`);
    lines.push(
      `${borderLeft}  ${color.yellow("[y]")} ${color.white("run once   ")}${color.yellow("[a]")} ${color.white("always   ")}${color.yellow("[n]")} ${color.white("cancel")}${borderRight}`,
    );
    lines.push(`${borderLeft}  ${borderRight}`);
    lines.push(
      `${borderLeft}  ${color.yellow("[e]")} ${color.white("expand details   ")}${color.yellow("[o]")} ${color.white("open output")}${borderRight}`,
    );
  }

  // Bottom border
  const bottom = `${BORDER_COLOR("└")}${BORDER_COLOR("─".repeat(innerWidth + 2))}`;
  lines.push(bottom);

  return lines;
}
