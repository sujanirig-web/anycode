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
  expanded: boolean;
  permission?: ShellApproval;
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

const STATUS_BORDER: Record<StepStatus, (s: string) => string> = {
  running: color.gray,
  ok: color.gray,
  warning: color.yellow,
  error: color.red,
};

function shortToolName(name: string): string {
  return name.length > 12 ? `${name.slice(0, 11)}…` : name;
}

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

export function intentForTool(call: ToolCall, input: Record<string, unknown>): string {
  const summary = describeCall(call, input);
  const tool = call.name;

  const intents: Record<string, string> = {
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

  const base = intents[tool] ?? "Running tool";

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
  const riskLevel = riskLevelFor(risk);

  return {
    tool: call.name,
    explanation: generateExplanation(call.name, command),
    reason: generateReason(call.name, command),
    riskLevel,
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
  const highRisk = ["rm ", "rmdir", "del ", "format", "fdisk", "mkfs", "shutdown", "reboot", "drop ", "kill -9", "killall"];
  const medRisk = ["npm install", "npm uninstall", "pip install", "pip uninstall", "chmod ", "chown ", "sudo ", "git push", "git reset", "git checkout", "> ", ">> "];

  if (highRisk.some((r) => lower.includes(r))) return "HIGH";
  if (medRisk.some((r) => lower.includes(r))) return "MEDIUM";
  return "LOW";
}

function riskLevelFor(risk: "LOW" | "MEDIUM" | "HIGH"): "LOW" | "MEDIUM" | "HIGH" {
  return risk;
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

function truncateWidth(text: string, width: number): string {
  const visible = text.replace(/\u001b\[[0-9;]*m/g, "");
  if (visible.length <= width) return text;
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
      intent,
      status: "running",
      steps: [],
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
      tool: call.name,
      status: "running",
      summary,
      args: oneLine(JSON.stringify(input), 200),
    };
    card.steps.push(step);
    card.status = "running";
    return step;
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
        card.status = isError ? "error" : "ok";
        return step;
      }
    }
    return undefined;
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
    if (card) card.permission = undefined;
  }

  getRenderCards(): ActivityCard[] {
    return this.cards;
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
