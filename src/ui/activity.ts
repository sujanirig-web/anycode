import type { ToolCall } from "../types.js";
import { describeCall, summarizeToolResult } from "./renderer.js";
import { formatNumber, oneLine } from "../util/text.js";
import { color } from "../util/ansi.js";

export type StepStatus = "running" | "ok" | "warning" | "error";

export interface Step {
  id: string;
  tool: string;
  status: StepStatus;
  summary: string;
  args?: string;
  detail?: string;
  output?: string;
  durationMs?: number;
  error?: string;
}

export interface ActivityPermission {
  tool: string;
  command: string;
  cwd?: string;
  risk?: string;
}

export interface ActivityCard {
  id: string;
  intent: string;
  status: StepStatus;
  steps: Step[];
  expanded: boolean;
  permission?: ActivityPermission;
}

export type ChatMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string }
  | { role: "activity"; card: ActivityCard };

const STATUS_ICON: Record<StepStatus, string> = {
  running: "⋯",
  ok: "✓",
  warning: "⚠",
  error: "✗",
};

const STATUS_COLOR: Record<StepStatus, (s: string) => string> = {
  running: color.blue,
  ok: color.green,
  warning: color.yellow,
  error: color.red,
};

function shortToolName(name: string): string {
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}

/** Format a step summary for display in a card tree line. */
export function formatStep(step: Step, width: number): string {
  const icon = STATUS_COLOR[step.status](STATUS_ICON[step.status]);
  const name = color.cyan(shortToolName(step.tool));
  const summary = color.dim(step.summary);
  let line = `├─ ${icon} ${name}  ${summary}`;
  if (step.durationMs !== undefined && step.status !== "running") {
    line += `  ${color.gray(`(${step.durationMs}ms)`)}`;
  }
  return truncateWidth(line, width);
}

function truncateWidth(text: string, width: number): string {
  // Use visible length for truncation (ANSI stripped)
  const visible = text.replace(/\u001b\[[0-9;]*m/g, "");
  if (visible.length <= width) return text;
  // Find a cut point that respects ANSI
  let out = "";
  let used = 0;
  let inAnsi = false;
  for (const char of text) {
    if (char === "\u001b") {
      inAnsi = true;
      out += char;
      continue;
    }
    if (inAnsi) {
      out += char;
      if (char >= "A" && char <= "Z") inAnsi = false;
      continue;
    }
    if (used + 1 > width - 1) {
      return out + "…";
    }
    out += char;
    used++;
  }
  return text;
}

/**
 * ActivityTracker groups tool calls into activity cards by intent.
 * Each turn gets one card; tool calls within the turn become steps.
 */
export class ActivityTracker {
  private cards: ActivityCard[] = [];
  private currentCardId: string | undefined;
  private stepCounter = 0;

  get allCards(): ActivityCard[] {
    return this.cards;
  }

  get currentCard(): ActivityCard | undefined {
    return this.currentCardId ? this.cards.find((c) => c.id === this.currentCardId) : undefined;
  }

  /** Start a new activity card for a turn. */
  startCard(intent: string): ActivityCard {
    const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const card: ActivityCard = {
      id,
      intent,
      status: "running",
      steps: [],
      expanded: true,
    };
    this.cards.push(card);
    this.currentCardId = id;
    return card;
  }

  /** Add a step to the current card. */
  addStep(call: ToolCall, input: Record<string, unknown>): Step {
    const card = this.currentCard;
    if (!card) throw new Error("No active activity card");

    const summary = describeCall(call, input);
    const step: Step = {
      id: `step-${++this.stepCounter}`,
      tool: call.name,
      status: "running",
      summary,
      args: oneLine(JSON.stringify(input), 200),
    };
    card.steps.push(step);
    card.status = "running";
    return step;
  }

  /** Complete a step with a result. */
  completeStep(
    stepId: string,
    content: string,
    isError: boolean,
    durationMs: number,
  ): Step | undefined {
    for (const card of this.cards) {
      const step = card.steps.find((s) => s.id === stepId);
      if (step) {
        step.status = isError ? "error" : "ok";
        step.summary = summarizeToolResult(step.tool, content);
        step.detail = content;
        step.durationMs = durationMs;
        if (isError) {
          const firstLine = content.split(/\r?\n/).find((l) => l.trim()) ?? "";
          step.error = firstLine;
        }
        card.status = isError ? "error" : "ok";
        return step;
      }
    }
    return undefined;
  }

  /** Set a permission request on the current card. */
  setPermission(permission: ActivityPermission): void {
    const card = this.currentCard;
    if (card) {
      card.permission = permission;
      card.status = "warning";
    }
  }

  /** Clear the permission request on the current card. */
  clearPermission(): void {
    const card = this.currentCard;
    if (card) card.permission = undefined;
  }

  /** Get cards for rendering (only non-permission cards unless a permission is pending). */
  getRenderCards(): ActivityCard[] {
    return this.cards;
  }

  /** Find a card by ID. */
  findCard(id: string): ActivityCard | undefined {
    return this.cards.find((c) => c.id === id);
  }

  /** Toggle expansion of a card. */
  toggleCard(id: string): boolean {
    const card = this.findCard(id);
    if (card) {
      card.expanded = !card.expanded;
      return card.expanded;
    }
    return false;
  }

  /** Collapse all cards. */
  collapseAll(): void {
    for (const card of this.cards) card.expanded = false;
  }

  /** Expand all cards. */
  expandAll(): void {
    for (const card of this.cards) card.expanded = true;
  }
}
