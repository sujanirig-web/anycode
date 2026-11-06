import type { ToolCall } from "../types.js";
import type { FileChange } from "../tools/types.js";
import { describeCall, summarizeToolResult } from "./renderer.js";
import { oneLine } from "../util/text.js";

export type StepStatus = "running" | "ok" | "warning" | "error";

export interface Step {
  id: string;
  /** Provider tool-call id, used to match a result to the right step. */
  callId?: string;
  tool: string;
  status: StepStatus;
  summary: string;
  args?: string;
  detail?: string;
  output?: string;
  durationMs?: number;
  error?: string;
}

export interface ShellApproval {
  tool: string;
  explanation: string;
  reason: string;
  riskLevel: "LOW" | "MEDIUM" | "HIGH";
  risk: string;
  primaryCommand: string;
  fullCommand: string;
}

export interface ActivityCard {
  id: string;
  intent: string;
  status: StepStatus;
  steps: Step[];
  /** Files touched while this card was active, in the order they changed. */
  changes?: FileChange[];
  expanded: boolean;
  permission?: ShellApproval;
}

const TOOL_INTENTS: Record<string, string> = {
  bash: "Running shell command",
  read: "Reading file",
  write: "Writing file",
  edit: "Editing file",
  glob: "Searching files",
  grep: "Searching code",
  list: "Listing directory",
  delete: "Deleting file",
  copy: "Copying file",
  move: "Moving file",
  mkdir: "Creating directory",
};

const HIGH_RISK_PATTERNS = [
  "rm ",
  "rmdir",
  "del ",
  "format",
  "fdisk",
  "mkfs",
  "shutdown",
  "reboot",
  "drop ",
  "kill -9",
  "killall",
];

const MEDIUM_RISK_PATTERNS = [
  "npm install",
  "npm uninstall",
  "pip install",
  "pip uninstall",
  "chmod ",
  "chown ",
  "sudo ",
  "git push",
  "git reset",
  "git checkout",
  "> ",
  ">> ",
];

export function intentForTool(call: ToolCall, input: Record<string, unknown>): string {
  const summary = describeCall(call, input);
  const base = TOOL_INTENTS[call.name] ?? "Running tool";

  if (summary && summary.length > 0) {
    const short = summary.length > 40 ? summary.slice(0, 37) + "…" : summary;
    return `${base}: "${short}"`;
  }

  return base;
}

export function shellApprovalFor(
  call: ToolCall,
  input: Record<string, unknown>,
): ShellApproval {
  const command = describeCall(call, input);
  const primary = extractPrimaryCommand(command);
  const risk = classifyRisk(command);

  return {
    tool: call.name,
    explanation: generateExplanation(call.name, command),
    reason: generateReason(call.name, command),
    riskLevel: risk,
    risk,
    primaryCommand: primary,
    fullCommand: command,
  };
}

function extractPrimaryCommand(command: string): string {
  const first = command.split("||")[0]?.split("&&")[0]?.trim() ?? "";
  return first.replace(/>\/dev\/null\s*$/, "").replace(/2>&1\s*$/, "").trim();
}

function classifyRisk(command: string): "LOW" | "MEDIUM" | "HIGH" {
  const lower = command.toLowerCase();
  if (HIGH_RISK_PATTERNS.some((pattern) => lower.includes(pattern))) return "HIGH";
  if (MEDIUM_RISK_PATTERNS.some((pattern) => lower.includes(pattern))) return "MEDIUM";
  return "LOW";
}

function generateExplanation(tool: string, command: string): string {
  if (tool === "bash") {
    const cmd = command.toLowerCase();
    if (cmd.includes("mkdir")) return "Cavehound wants to create a new directory.";
    if (cmd.includes("ls ") || cmd.includes("dir ")) return "Cavehound wants to list directory contents.";
    if (cmd.includes("rm ")) return "Cavehound wants to delete files or directories.";
    if (cmd.includes("npm install") || cmd.includes("pip install")) return "Cavehound wants to install packages.";
    if (cmd.includes("git ")) return "Cavehound wants to run a git command.";
    if (cmd.includes("cat ") || cmd.includes("type ")) return "Cavehound wants to read a file's contents.";
    if (cmd.includes("echo ")) return "Cavehound wants to write text to a file.";
    return "Cavehound wants to run a shell command.";
  }
  return `${tool} wants to perform an action.`;
}

function generateReason(tool: string, command: string): string {
  if (tool === "bash") {
    const cmd = command.toLowerCase();
    if (cmd.includes("mkdir")) return "I need a project folder before creating the project files.";
    if (cmd.includes("ls ") || cmd.includes("dir ")) return "I need to see what files are in the directory.";
    if (cmd.includes("rm ")) return "I need to remove files that are no longer needed.";
    if (cmd.includes("npm install") || cmd.includes("pip install")) return "I need to install dependencies for the project.";
    if (cmd.includes("git ")) return "I need to manage version control for this project.";
    if (cmd.includes("cat ") || cmd.includes("type ")) return "I need to read the contents of a file.";
    if (cmd.includes("echo ")) return "I need to write configuration or data to a file.";
    return "I need to run this command to complete the task.";
  }
  return `I need to run ${tool} to complete the task.`;
}

export class ActivityTracker {
  private cards: ActivityCard[] = [];
  private currentCardId: string | undefined;
  private stepCounter = 0;
  private verbose = false;

  get allCards(): ActivityCard[] {
    return this.cards;
  }

  get currentCard(): ActivityCard | undefined {
    return this.currentCardId ? this.cards.find((c) => c.id === this.currentCardId) : undefined;
  }

  get lastCard(): ActivityCard | undefined {
    return this.cards[this.cards.length - 1];
  }

  get isVerbose(): boolean {
    return this.verbose;
  }

  toggleVerbose(): boolean {
    this.verbose = !this.verbose;
    return this.verbose;
  }

  startCard(intent: string): ActivityCard {
    const id = `card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const card: ActivityCard = {
      id,
      intent: oneLine(intent, 120),
      status: "running",
      steps: [],
      changes: [],
      expanded: true,
    };
    this.cards.push(card);
    this.currentCardId = id;
    return card;
  }

  addStep(call: ToolCall, input: Record<string, unknown>): Step {
    let card = this.currentCard;
    if (!card) {
      card = this.startCard(intentForTool(call, input));
    }

    const summary = describeCall(call, input);
    const step: Step = {
      id: `step-${++this.stepCounter}`,
      callId: call.id,
      tool: call.name,
      status: "running",
      summary,
      args: oneLine(JSON.stringify(input), 200),
    };
    card.steps.push(step);
    card.status = "running";
    return step;
  }

  /**
   * Attach a filesystem change to the active box. Changes appear beside the
   * tool steps that produced them instead of as detached transcript entries.
   */
  addChange(change: FileChange): ActivityCard {
    let card = this.currentCard;
    if (!card) {
      card = this.startCard(`Changes to ${change.path}`);
    }
    (card.changes ??= []).push(change);
    card.status = "running";
    return card;
  }

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
        this.refreshCardStatus(card);
        return step;
      }
    }
    return undefined;
  }

  /** Complete the step that belongs to a specific provider tool call. */
  completeStepByCall(
    callId: string,
    content: string,
    isError: boolean,
    durationMs: number,
  ): { card: ActivityCard; step: Step } | undefined {
    for (const card of this.cards) {
      const step = card.steps.find((candidate) => candidate.callId === callId);
      if (step) {
        this.completeStep(step.id, content, isError, durationMs);
        return { card, step };
      }
    }
    return undefined;
  }

  /**
   * Close the current card. Any step still running is marked as interrupted,
   * then the card is collapsed unless verbose mode is on.
   */
  finishCurrentCard(): ActivityCard | undefined {
    const card = this.currentCard;
    if (!card) return undefined;
    this.currentCardId = undefined;

    for (const step of card.steps) {
      if (step.status === "running") step.status = "warning";
    }
    this.refreshCardStatus(card);
    if (!this.verbose) card.expanded = false;
    return card;
  }

  setShellApproval(approval: ShellApproval): void {
    const card = this.currentCard;
    if (card) {
      card.permission = approval;
      card.status = "warning";
    }
  }

  clearPermission(): void {
    const card = this.currentCard;
    if (card) {
      card.permission = undefined;
      this.refreshCardStatus(card);
    }
  }

  private refreshCardStatus(card: ActivityCard): void {
    if (card.permission) {
      card.status = "warning";
      return;
    }
    if (card.steps.some((step) => step.status === "error")) card.status = "error";
    else if (card.steps.some((step) => step.status === "running")) card.status = "running";
    else if (card.steps.some((step) => step.status === "warning")) card.status = "warning";
    else card.status = "ok";
  }

  findCard(id: string): ActivityCard | undefined {
    return this.cards.find((c) => c.id === id);
  }

  toggleCard(id: string): boolean {
    const card = this.findCard(id);
    if (card) {
      card.expanded = !card.expanded;
      return card.expanded;
    }
    return false;
  }

  collapseAll(): void {
    for (const card of this.cards) card.expanded = false;
  }

  expandAll(): void {
    for (const card of this.cards) card.expanded = true;
  }
}
