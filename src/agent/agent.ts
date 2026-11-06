import { ProviderError, ToolError, errorMessage, isAbortError } from "../errors.js";
import { builtinTools } from "../tools/index.js";
import type { FileChange, PermissionRequest, Tool } from "../tools/types.js";
import type { Message, Provider, ToolCall, ToolSchema, Usage } from "../types.js";
import { addUsage, EMPTY_USAGE } from "../types.js";
import { estimateTokens, safeJsonParse, truncateMiddle } from "../util/text.js";
import type { Session } from "./session.js";

export type AgentEvent =
  | { type: "turn_start"; step: number }
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_start"; call: ToolCall; input: Record<string, unknown> }
  | {
      type: "tool_end";
      call: ToolCall;
      content: string;
      isError: boolean;
      durationMs: number;
    }
  | { type: "usage"; usage: Usage }
  | { type: "file_change"; change: FileChange }
  | { type: "compaction"; removedMessages: number }
  | { type: "notice"; message: string }
  | { type: "error"; message: string; recoverable: boolean; hint?: string }
  | { type: "done"; steps: number; usage: Usage; aborted: boolean };

export interface AgentOptions {
  provider: Provider;
  model: string;
  cwd: string;
  session: Session;
  system: string;
  tools?: Tool[];
  maxSteps?: number;
  maxTokens?: number;
  temperature?: number;
  contextTokens?: number;
  /** Force the model to call at least one tool on user-message turns. */
  toolChoice?: "required" | "none" | "auto";
  approve: (request: PermissionRequest) => Promise<boolean>;
}

const MAX_TOOL_OUTPUT = 60_000;

export class Agent {
  private readonly tools: Tool[];
  private readonly toolMap: Map<string, Tool>;
  private readonly toolSpecs: ToolSchema[];
  private readonly toolNames: string;
  private readonly maxSteps: number;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;
  private readonly contextTokens: number;
  private readonly toolChoice: "required" | "none" | "auto";
  private readonly approve: (request: PermissionRequest) => Promise<boolean>;

  constructor(private readonly options: AgentOptions) {
    this.tools = options.tools ?? builtinTools;
    this.toolMap = new Map();
    // Preserve first-match semantics if a caller supplies duplicate names.
    for (const tool of this.tools) {
      if (!this.toolMap.has(tool.name)) this.toolMap.set(tool.name, tool);
    }
    // Tool definitions are immutable for the agent's lifetime, so build the
    // provider-facing schemas once instead of on every step.
    this.toolSpecs = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    }));
    this.toolNames = this.tools.map((tool) => tool.name).join(", ");
    this.maxSteps = options.maxSteps ?? 50;
    this.maxTokens = options.maxTokens ?? 8192;
    this.temperature = options.temperature;
    this.contextTokens = options.contextTokens ?? 200_000;
    this.toolChoice = options.toolChoice ?? "auto";
    this.approve = options.approve;
  }

  /** Characters a message contributes to the context budget. */
  private static messageChars(message: Message): number {
    if (message.role !== "assistant") return message.content.length;
    const toolChars = (message.toolCalls ?? []).reduce(
      (sum, call) => sum + call.arguments.length,
      0,
    );
    return message.content.length + toolChars;
  }

  /** Detect a tool-calling loop: same tool+args repeated 3+ times in a row. */
  private isToolLoop(
    recentCalls: Array<{ name: string; arguments: string }>,
  ): boolean {
    if (recentCalls.length < 3) return false;
    const last = recentCalls[recentCalls.length - 1]!;
    const secondLast = recentCalls[recentCalls.length - 2]!;
    const thirdLast = recentCalls[recentCalls.length - 3]!;
    return (
      last.name === secondLast.name &&
      last.name === thirdLast.name &&
      last.arguments === secondLast.arguments &&
      last.arguments === thirdLast.arguments
    );
  }

  get session(): Session {
    return this.options.session;
  }

  /**
   * Run one user turn to completion, yielding normalized events as the model
   * thinks, speaks and calls tools. The session is saved after every step.
   */
  async *run(
    userText: string,
    runOptions: { signal?: AbortSignal } = {},
  ): AsyncGenerator<AgentEvent> {
    const { signal } = runOptions;
    const session = this.options.session;

    session.messages.push({ role: "user", content: userText });
    session.touch(userText);

    let aborted = false;
    let steps = 0;

    try {
      for (; steps < this.maxSteps; steps++) {
        if (signal?.aborted) {
          aborted = true;
          break;
        }

        const removed = this.trimHistory();
        if (removed > 0) yield { type: "compaction", removedMessages: removed };

        yield { type: "turn_start", step: steps + 1 };

        let assistantText = "";
        const toolCalls: ToolCall[] = [];
        const recentToolCalls: Array<{ name: string; arguments: string }> = [];
        let stepUsage: Usage = { ...EMPTY_USAGE };
        let doneReason: string = "stop";

        try {
          for await (const event of this.options.provider.stream({
            model: this.options.model,
            system: this.options.system,
            messages: session.messages,
            tools: this.toolSpecs,
            maxTokens: this.maxTokens,
            ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
            ...(signal ? { signal } : {}),
            toolChoice: this.toolChoice,
          })) {
            switch (event.type) {
              case "text":
                assistantText += event.text;
                yield { type: "text", text: event.text };
                break;

              case "reasoning":
                yield { type: "reasoning", text: event.text };
                break;

              case "tool_call":
                toolCalls.push(event.call);
                recentToolCalls.push({ name: event.call.name, arguments: event.call.arguments ?? "{}" });
                break;

              case "usage":
                stepUsage = addUsage(stepUsage, event.usage);
                session.usage = addUsage(session.usage, event.usage);
                yield { type: "usage", usage: session.usage };
                break;

              case "done":
                doneReason = event.reason;
                if (event.message) {
                  yield { type: "error", message: event.message, recoverable: true };
                }
                break;
            }
          }
        } catch (error) {
          if (isAbortError(error) || signal?.aborted) {
            aborted = true;
            break;
          }
          const hint =
            error instanceof ToolError || error instanceof ProviderError
              ? error.hint
              : undefined;
          yield {
            type: "error",
            message: errorMessage(error),
            recoverable: false,
            ...(hint ? { hint } : {}),
          };
          break;
        }

        if (assistantText.length > 0 || toolCalls.length > 0) {
          session.messages.push({
            role: "assistant",
            content: assistantText,
            ...(toolCalls.length > 0 ? { toolCalls } : {}),
          });
        }

        if (doneReason === "length") {
          yield {
            type: "notice",
            message: "The model hit the output token limit; the response may be incomplete.",
          };
        }

        if (toolCalls.length === 0) break;

        // The loop guard only depends on calls seen before this batch.
        const loopDetected = this.isToolLoop(recentToolCalls);

        for (const call of toolCalls) {
          if (signal?.aborted) {
            aborted = true;
            break;
          }

          // Break tool-calling loops: same tool+args repeated 3+ times in a row.
          if (loopDetected) {
            const content = `Stopped: detected a tool-calling loop (${call.name} repeated). Respond to the user directly instead of calling tools again.`;
            session.messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content,
              isError: true,
            });
            yield {
              type: "tool_end",
              call,
              content,
              isError: true,
              durationMs: 0,
            };
            break;
          }

          const started = Date.now();
          const tool = this.toolMap.get(call.name);

          if (!tool) {
            const content = `Unknown tool "${call.name}". Available tools: ${this.toolNames}.`;
            session.messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content,
              isError: true,
            });
            yield {
              type: "tool_end",
              call,
              content,
              isError: true,
              durationMs: Date.now() - started,
            };
            continue;
          }

          const parsed = safeJsonParse<Record<string, unknown>>(call.arguments || "{}");
          if (!parsed.ok || parsed.value === null || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
            const content = `Invalid JSON arguments for ${call.name}: ${parsed.error ?? "expected an object"}`;
            session.messages.push({
              role: "tool",
              toolCallId: call.id,
              name: call.name,
              content,
              isError: true,
            });
            yield {
              type: "tool_end",
              call,
              content,
              isError: true,
              durationMs: Date.now() - started,
            };
            continue;
          }

          const input = parsed.value;
          yield { type: "tool_start", call, input };

          let content: string;
          let isError = false;
          const changes: FileChange[] = [];
          try {
            content = await tool.execute(input, {
              cwd: this.options.cwd,
              ...(signal ? { signal } : {}),
              approve: this.approve,
              onFileChange: (change) => changes.push(change),
            });
          } catch (error) {
            isError = true;
            if (error instanceof ToolError) {
              content = error.hint ? `${error.message}\nHint: ${error.hint}` : error.message;
            } else if (isAbortError(error)) {
              content = "Tool execution was aborted.";
            } else {
              content = `Tool failed: ${errorMessage(error)}`;
            }
          }

          content = truncateMiddle(content, MAX_TOOL_OUTPUT, "tool output truncated");
          session.messages.push({
            role: "tool",
            toolCallId: call.id,
            name: call.name,
            content,
            ...(isError ? { isError: true } : {}),
          });

          yield {
            type: "tool_end",
            call,
            content,
            isError,
            durationMs: Date.now() - started,
          };

          // Surface mutations only after the tool result so the UI can attach
          // the diff to the finished card instead of racing its summary.
          for (const change of changes) {
            yield { type: "file_change", change };
          }
        }

        await session.save();
        if (aborted) break;
      }

      if (!aborted && steps >= this.maxSteps) {
        yield {
          type: "error",
          message: `Stopped after ${this.maxSteps} steps (maxSteps). Raise maxSteps in config if the task needs more.`,
          recoverable: true,
        };
      }
    } finally {
      await session.save().catch(() => undefined);
    }

    yield {
      type: "done",
      steps,
      usage: session.usage,
      aborted,
    };
  }

  /**
   * Drop the oldest user turns when the history grows past ~60% of the context
   * window. Only cuts at user-message boundaries so tool_use/tool_result pairs
   * stay intact.
   */
  private trimHistory(): number {
    const budgetChars = this.contextTokens * 4 * 0.6;
    const messages = this.options.session.messages;
    let current = messages.reduce((total, message) => total + Agent.messageChars(message), 0);

    let removed = 0;

    while (current > budgetChars && messages.length > 6) {
      const nextUser = messages.findIndex(
        (message, index) => index > 0 && message.role === "user",
      );
      if (nextUser <= 0) break;

      for (let index = 0; index < nextUser; index++) {
        current -= Agent.messageChars(messages[index]!);
      }
      messages.splice(0, nextUser);
      removed += nextUser;
    }

    return removed;
  }

  /** Rough token estimate for the current history (useful for status output). */
  historyTokens(): number {
    return this.options.session.messages.reduce((total, message) => {
      return total + estimateTokens(message.content);
    }, 0);
  }
}
