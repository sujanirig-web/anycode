import { stdin as input, stdout as output } from "node:process";
import type { AgentEvent } from "../agent/agent.js";
import type { PermissionAnswer } from "../agent/permissions.js";
import { errorMessage } from "../errors.js";
import type { PermissionRequest } from "../tools/types.js";
import type { ToolCall } from "../types.js";

import { color } from "../util/ansi.js";
import { NAME, VERSION } from "../version.js";
import { handleSlashCommand, type CommandItem, COMMANDS } from "./commands.js";
import { Editor } from "./editor.js";
import { KeyParser, type KeyEvent } from "./keys.js";
import type { ChatState, InteractiveRuntime } from "./runtime.js";
import { composeFrame, type Frame } from "./screen.js";
import { Transcript } from "./transcript.js";
import { ActivityTracker, shellApprovalFor } from "./activity.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Buffer/loader bars that pulse to show the model is actively thinking. */
const BUFFER = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█", "▇", "▆", "▅", "▄", "▃", "▂", "▁"];
const PASTE_ON = "\u001b[?2004h";
const PASTE_OFF = "\u001b[?2004l";
const ALT_ON = "\u001b[?1049h";
const ALT_OFF = "\u001b[?1049l";
const CURSOR_ON = "\u001b[?25h";
const CURSOR_OFF = "\u001b[?25l";
const CTRL_C_WINDOW_MS = 1500;
const TICK_MS = 50;



interface BusyState {
  controller: AbortController;
  label: string;
  startedAt: number;
}

interface PendingApproval {
  request: PermissionRequest;
  resolve: (answer: PermissionAnswer) => void;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

class Painter {
  private previous: string[] = [];

  constructor(private readonly out: NodeJS.WriteStream) {}

  reset(): void {
    this.previous = [];
    this.out.write("\u001b[2J\u001b[H");
  }

  paint(frame: Frame): void {
    const lines = frame.lines;
    let out = "";

    if (this.previous.length !== lines.length) {
      out += "\u001b[2J";
      this.previous = [];
    }
    out += CURSOR_OFF;

    for (let row = 0; row < lines.length; row++) {
      const line = lines[row] ?? "";
      if (line === this.previous[row]) continue;
      out += `\u001b[${row + 1};1H${line}\u001b[K`;
    }

    if (frame.cursor) {
      out += `\u001b[${frame.cursor.row + 1};${frame.cursor.col + 1}H${CURSOR_ON}`;
    }

    this.out.write(out);
    this.previous = lines.slice();
  }
}

/** Full-screen interactive UI: alternate screen, transcript, composer, status. */
export class Tui {
  private readonly state: ChatState;
  private readonly transcript = new Transcript();
  private readonly editor = new Editor();
  private readonly parser = new KeyParser();
  private readonly painter = new Painter(output);
  private readonly tracker = new ActivityTracker();

  private scroll = 0;
  private expanded = false;
  private busy?: BusyState;
  private approval?: PendingApproval;
  private frame?: Frame;

  /** Command palette state. */
  private paletteOpen = false;
  private paletteFilter = "";
  private paletteSelected = 0;

  /** Activity card navigation. */
  private selectedCardIndex = 0;
  private selectedStepIndex: number | undefined;

  private tick?: NodeJS.Timeout;
  private paintTimer?: NodeJS.Timeout;
  private escapeTimer?: NodeJS.Timeout;
  private lastInterrupt = 0;
  private cleaned = false;

  private readonly done: Promise<void>;
  private resolveDone!: () => void;

  constructor(private readonly runtime: InteractiveRuntime) {
    this.state = {
      session: runtime.session,
      agent: runtime.agent,
      providerId: runtime.providerId,
      model: runtime.model,
    };
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
    runtime.broker.handler = (request) => this.ask(request);
  }

  async run(): Promise<void> {
    this.welcome();
    this.enter();
    try {
      await this.done;
    } finally {
      this.cleanup();
    }
  }

  private enter(): void {
    output.write(`${ALT_ON}${PASTE_ON}\u001b[2J\u001b[H${CURSOR_OFF}`);
    input.setRawMode?.(true);
    input.setEncoding("utf8");
    input.resume();
    input.on("data", this.onData);
    output.on("resize", this.onResize);
    process.on("exit", this.restore);
    process.on("SIGTERM", this.onTerminate);
    this.paint();
  }

  private welcome(): void {
    this.transcript.welcome({
      cwd: this.runtime.cwd,
      provider: this.state.providerId,
      model: this.state.model,
      autoApprove: this.runtime.broker.autoApprove,
    });
    if (this.state.session.messages.length > 0) {
      this.transcript.info("Resumed session.");
      this.transcript.hydrate(this.state.session);
    }
  }

  private restore = (): void => {
    output.write(`${PASTE_OFF}${CURSOR_ON}${ALT_OFF}`);
  };

  private cleanup(): void {
    if (this.cleaned) return;
    this.cleaned = true;

    if (this.tick) clearInterval(this.tick);
    if (this.paintTimer) clearTimeout(this.paintTimer);
    if (this.escapeTimer) clearTimeout(this.escapeTimer);

    input.off("data", this.onData);
    output.off("resize", this.onResize);
    process.off("exit", this.restore);
    process.off("SIGTERM", this.onTerminate);

    try {
      input.setRawMode?.(false);
    } catch {
      // Terminal may already be gone; nothing useful to do.
    }
    input.pause();
    this.restore();
  }

  private quit(): void {
    if (this.approval) {
      this.approval.resolve("no");
      this.approval = undefined;
    }
    if (this.busy) this.busy.controller.abort();
    this.resolveDone();
  }

  private onTerminate = (): void => {
    this.cleanup();
    process.exit(130);
  };

  private onResize = (): void => {
    this.painter.reset();
    this.paint();
  };

  private onData = (chunk: string): void => {
    const events = this.parser.push(chunk);
    for (const event of events) this.handleKey(event);
    if (this.parser.pendingLength > 0) this.scheduleEscapeFlush();
  };

  private scheduleEscapeFlush(): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.escapeTimer = setTimeout(() => {
      this.escapeTimer = undefined;
      for (const event of this.parser.flush()) this.handleKey(event);
    }, 30);
  }

  private handleKey(event: KeyEvent): void {
    if (this.approval) {
      this.handleApprovalKey(event);
      return;
    }

    if (this.paletteOpen) {
      this.handlePaletteKey(event);
      return;
    }

    if (event.type === "text") {
      this.applyEdit(event);
      return;
    }
    const name = event.name;
    const ctrl = event.ctrl === true;

    if (ctrl && name === "c") {
      this.interrupt();
      return;
    }
    if (ctrl && name === "d" && this.editor.isEmpty) {
      this.quit();
      return;
    }
    if (ctrl && name === "o") {
      this.expanded = !this.expanded;
      this.paint();
      return;
    }
    if (ctrl && name === "l") {
      this.painter.reset();
      this.paint();
      return;
    }
    if (ctrl && name === "t") {
      const verbose = this.tracker.toggleVerbose();
      this.transcript.notice(verbose ? "Verbose mode: all cards expanded" : "Verbose mode: cards collapse after completion");
      this.paint();
      return;
    }
    if (name === "pageup") {
      this.scrollBy(this.pageSize());
      return;
    }
    if (name === "pagedown") {
      this.scrollBy(-this.pageSize());
      return;
    }
    if (name === "e") {
      // Expand/collapse the selected activity card
      const card = this.tracker.currentCard;
      if (card) {
        this.tracker.toggleCard(card.id);
        this.paint();
      }
      return;
    }
    if (name === "o") {
      // Toggle raw output for selected step - handled by transcript
      this.paint();
      return;
    }
    if (name === "v") {
      // View full command for selected step
      this.paint();
      return;
    }
    if (name === "r") {
      // Retry a failed step
      this.paint();
      return;
    }
    if (name === "tab") {
      // Queue message while agent is working
      this.paint();
      return;
    }

    this.applyEdit(event);
  }

  private applyEdit(event: KeyEvent): void {
    const result = this.editor.handle(event);
    if (result.type === "changed") {
      // Open command palette when "/" is typed at the start.
      if (
        !this.paletteOpen &&
        this.editor.text === "/" &&
        this.editor.cursor === 1
      ) {
        this.openPalette();
      }
      this.paint();
      return;
    }
    if (result.type === "submit") {
      if (this.paletteOpen) {
        this.selectPaletteItem();
        return;
      }
      this.submit(result.text).catch((error: unknown) => {
        this.transcript.error(errorMessage(error));
        this.paint();
      });
    }
  }

  /** Open the command palette. */
  private openPalette(): void {
    this.paletteOpen = true;
    this.paletteFilter = "/";
    this.paletteSelected = 0;
    this.editor.setText("/");
    this.paint();
  }

  /** Close the command palette and clear the composer. */
  private closePalette(): void {
    this.paletteOpen = false;
    this.paletteFilter = "";
    this.paletteSelected = 0;
    this.editor.clear();
    this.paint();
  }

  /** Handle keys while the command palette is open. */
  private handlePaletteKey(event: KeyEvent): void {
    if (event.type === "text") {
      // Append typed text to filter and editor.
      this.editor.handle(event);
      this.paletteFilter = this.editor.text;
      this.paletteSelected = 0;
      this.paint();
      return;
    }

    const name = event.name;
    const ctrl = event.ctrl === true;

    if (ctrl && name === "c") {
      this.closePalette();
      return;
    }
    if (name === "escape") {
      this.closePalette();
      return;
    }
    if (name === "enter") {
      this.selectPaletteItem();
      return;
    }
    if (name === "backspace") {
      this.editor.handle(event);
      this.paletteFilter = this.editor.text;
      if (this.paletteFilter === "/") {
        this.paletteSelected = 0;
      }
      if (this.editor.text.length <= 1) {
        this.closePalette();
        return;
      }
      this.paint();
      return;
    }
    if (name === "up") {
      this.paletteSelected = (this.paletteSelected - 1 + this.filteredCommands().length) % this.filteredCommands().length;
      this.paint();
      return;
    }
    if (name === "down") {
      this.paletteSelected = (this.paletteSelected + 1) % this.filteredCommands().length;
      this.paint();
      return;
    }

    // Let other keys (home, end, arrows, etc.) pass through to the editor.
    this.editor.handle(event);
    this.paletteFilter = this.editor.text;
    this.paletteSelected = 0;
    this.paint();
  }

  /** Commands matching the current palette filter. */
  private filteredCommands(): CommandItem[] {
    const f = this.paletteFilter.slice(1).toLowerCase(); // strip leading "/"
    return COMMANDS.filter((c) => c.name.includes(f) || c.desc.toLowerCase().includes(f));
  }

  /** Execute the currently selected palette item. */
  private selectPaletteItem(): void {
    const cmd = this.filteredCommands()[this.paletteSelected];
    if (!cmd) {
      this.closePalette();
      return;
    }
    this.closePalette();
    // Execute the slash command via the shared handler.
    const text = `/${cmd.name}`;
    const sink = {
      info: (message: string): void => {
        this.transcript.info(message);
      },
      error: (message: string, hint?: string): void => {
        this.transcript.error(message, hint);
      },
    };
    this.submit(text).catch((error: unknown) => {
      this.transcript.error(errorMessage(error));
      this.paint();
    });
  }

  /** Render the command palette overlay lines. */
  private renderPalette(width: number): string[] {
    const cmds = this.filteredCommands();
    if (cmds.length === 0) {
      return [color.dim("  No matching commands.")];
    }

    const lines: string[] = [];
    lines.push(color.bold(color.magenta(" Commands")));
    lines.push("");

    const maxShow = Math.max(1, Math.floor(width / 2) - 2);
    const start = Math.max(0, this.paletteSelected - Math.floor(maxShow / 2));
    const end = Math.min(cmds.length, start + maxShow);

    for (let i = start; i < end; i++) {
      const cmd = cmds[i];
      if (!cmd) continue;
      const isSelected = i === this.paletteSelected;
      const marker = isSelected ? "▸ " : "  ";
      const namePart = color.bold(color.cyan(`/${cmd.name}`));
      const descPart = color.dim(cmd.desc);
      const argsPart = cmd.args ? ` ${color.gray(cmd.args)}` : "";
      const line = `  ${marker}${namePart}${argsPart}  ${descPart}`;
      lines.push(isSelected ? color.inverse(line) : line);
    }

    return lines;
  }

  private handleApprovalKey(event: KeyEvent): void {
    const answerFor = (value: string): PermissionAnswer | undefined => {
      const lower = value.trim().toLowerCase();
      if (lower.startsWith("y")) return "yes";
      if (lower.startsWith("a")) return "always";
      if (lower.startsWith("n")) return "no";
      return undefined;
    };

    if (event.type === "text") {
      const answer = answerFor(event.text);
      if (answer) this.answer(answer);
      return;
    }

    if (event.name === "escape" || event.name === "enter" || (event.ctrl && event.name === "c")) {
      this.answer("no");
      return;
    }

    const answer = answerFor(event.name);
    if (answer) this.answer(answer);
  }

  private answer(value: PermissionAnswer): void {
    const pending = this.approval;
    if (!pending) return;
    this.approval = undefined;
    this.tracker.clearPermission();
    const card = this.tracker.currentCard;
    if (card) this.transcript.updateCurrentActivity(card);
    pending.resolve(value);
    this.paint();
  }

  private ask(request: PermissionRequest): Promise<PermissionAnswer> {
    return new Promise<PermissionAnswer>((resolve) => {
      this.approval = { request, resolve };
      const toolCall: ToolCall = {
        id: `call-${Date.now()}`,
        name: request.tool,
        arguments: JSON.stringify({ command: request.detail ?? "" }),
      };
      const approval = shellApprovalFor(toolCall, { command: request.detail ?? "" });
      this.tracker.setShellApproval(approval);
      this.transcript.updateCurrentActivity(this.tracker.currentCard!);
      this.paint();
    });
  }

  private interrupt(): void {
    if (this.busy) {
      this.busy.controller.abort();
      this.busy.label = "stopping";
      this.paint();
      return;
    }
    if (this.editor.clear()) {
      this.paint();
      return;
    }
    const now = Date.now();
    if (now - this.lastInterrupt < CTRL_C_WINDOW_MS) {
      this.quit();
      return;
    }
    this.lastInterrupt = now;
    this.transcript.notice("Press ctrl+c again to exit.");
    this.paint();
  }

  private async submit(text: string): Promise<void> {
    this.scroll = 0;

    if (text.startsWith("/")) {
      const before = this.state.session.id;
      const sink = {
        info: (message: string): void => {
          this.transcript.info(message);
        },
        error: (message: string, hint?: string): void => {
          this.transcript.error(message, hint);
        },
      };

      const exit = await handleSlashCommand(text, this.runtime, this.state, sink);
      if (exit) {
        this.quit();
        return;
      }

      if (this.state.session.id !== before) {
        this.transcript.clear();
        this.transcript.welcome({
          cwd: this.runtime.cwd,
          provider: this.state.providerId,
          model: this.state.model,
          autoApprove: this.runtime.broker.autoApprove,
        });
        if (this.state.session.messages.length > 0) this.transcript.hydrate(this.state.session);
      }

      this.paint();
      return;
    }

    await this.startTurn(text);
  }

  private async startTurn(text: string): Promise<void> {
    if (this.busy) {
      this.transcript.notice("A turn is already running. Press ctrl+c to interrupt it.");
      this.paint();
      return;
    }

    this.transcript.pushUser(text);
    this.scroll = 0;

    const controller = new AbortController();
    this.busy = { controller, label: "thinking", startedAt: Date.now() };
    this.tick = setInterval(() => this.paint(), TICK_MS);
    this.paint();

    try {
      for await (const event of this.state.agent.run(text, { signal: controller.signal })) {
        this.onEvent(event);
      }
    } catch (error) {
      if (!controller.signal.aborted) this.transcript.error(errorMessage(error));
    } finally {
      if (this.tick) {
        clearInterval(this.tick);
        this.tick = undefined;
      }
      this.busy = undefined;
      await this.state.session.save().catch(() => undefined);
      this.paint();
    }
  }

  private onEvent(event: AgentEvent): void {
    switch (event.type) {
      case "turn_start":
        if (this.busy) this.busy.label = event.step > 1 ? `step ${event.step}` : "thinking";
        this.schedulePaint();
        break;
      case "text":
        this.transcript.appendAssistant(event.text);
        this.schedulePaint();
        break;
      case "reasoning":
        break;
      case "tool_start": {
        const step = this.tracker.addStep(event.call, event.input);
        this.transcript.updateCurrentActivity(this.tracker.currentCard!);
        this.paint();
        break;
      }
      case "tool_end": {
        // Find the step id for this tool call - we need to track it
        // For now, complete the most recent running step
        const card = this.tracker.currentCard;
        if (card) {
          const runningStep = card.steps.find((s) => s.status === "running");
          if (runningStep) {
            this.tracker.completeStep(runningStep.id, event.content, event.isError, event.durationMs);
            this.transcript.updateCurrentActivity(card);
          }
        }
        this.paint();
        break;
      }
      case "compaction":
        this.transcript.notice(
          `Trimmed ${event.removedMessages} old messages to stay inside the context window.`,
        );
        this.paint();
        break;
      case "notice":
        this.transcript.notice(event.message);
        this.paint();
        break;
      case "error":
        this.transcript.error(event.message, event.hint);
        this.paint();
        break;
      case "usage":
        this.transcript.setUsage(event.usage);
        this.schedulePaint();
        break;
      case "done":
        if (event.aborted) {
          this.transcript.notice("Interrupted.");
          this.paint();
        }
        break;
    }
  }

  private schedulePaint(): void {
    if (this.paintTimer) return;
    this.paintTimer = setTimeout(() => {
      this.paintTimer = undefined;
      this.paint();
    }, 33);
  }

  private pageSize(): number {
    return Math.max(1, (this.frame?.bodyHeight ?? 10) - 2);
  }

  private scrollBy(delta: number): void {
    this.scroll = Math.max(0, this.scroll + delta);
    this.paint();
  }

  private statusLeft(): string {
    if (this.busy) {
      const elapsed = (Date.now() - this.busy.startedAt) / 1000;
      const frame = SPINNER[Math.floor(elapsed * 10) % SPINNER.length] ?? "⠋";
      const buffer = BUFFER[Math.floor(elapsed * 20) % BUFFER.length] ?? "█";
      const seconds = elapsed.toFixed(elapsed >= 10 ? 0 : 1);
      return `${buffer} ${frame} ${this.busy.label} · ${seconds}s`;
    }
    return "";
  }

  private statusRight(): string {
    return this.scroll > 0 ? `↑ ${this.scroll}` : "";
  }

  private compose(width: number, height: number, lines: string[]): Frame {
    // If the command palette is open, overlay it on top of the transcript.
    if (this.paletteOpen) {
      const palette = this.renderPalette(width);
      lines = [...palette, ...lines];
    }

    const header = `${this.state.providerId}/${this.state.model} · ~/projects`;
    return composeFrame({
      width,
      height,
      header,
      showHeader: true,
      transcript: lines,
      scroll: this.scroll,
      statusLeft: this.statusLeft(),
      statusRight: this.statusRight(),
      composer: { text: this.editor.text, cursor: this.editor.cursor },
      ...(this.approval
        ? {
            approval: {
              title: this.approval.request.title,
              ...(this.approval.request.detail ? { detail: this.approval.request.detail } : {}),
            },
          }
        : {}),
      usage: this.state.session.usage,
      agentName: "Cavehound",
      agentMode: this.busy ? "running" : "idle",
      });
  }

  private paint(): void {
    if (this.cleaned) return;

    const width = clamp(output.columns ?? 80, 20, 400);
    const height = Math.max(6, output.rows ?? 24);
    const lines = this.transcript.render(Math.max(10, width - 2), this.expanded);

    let frame = this.compose(width, height, lines);
    const maxScroll = Math.max(0, lines.length - frame.bodyHeight);
    if (this.scroll > maxScroll) {
      this.scroll = maxScroll;
      frame = this.compose(width, height, lines);
    }

    this.frame = frame;
    this.painter.paint(frame);
  }
}

export async function runTui(runtime: InteractiveRuntime): Promise<void> {
  const tui = new Tui(runtime);
  await tui.run();
}
