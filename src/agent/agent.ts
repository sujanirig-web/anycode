import { ToolError, errorMessage, isAbortError } from "../errors.js";
import { builtinTools, findTool } from "../tools/index.js";
import type { PermissionRequest, Tool } from "../tools/types.js";
import type { Provider, ToolCall, Usage } from "../types.js";
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
  approve: (request: PermissionRequest) => Promise<boolean>;
}

const MAX_TOOL_OUTPUT = 60_000;

export class Agent {
  private readonly tools: Tool[];
  private readonly maxSteps: number;
  private readonly maxTokens: number;
  private readonly temperature: number | undefined;
  private readonly contextTokens: number;
  private readonly approve: (request: PermissionRequest) => Promise<boolean>;

  constructor(private readonly options: AgentOptions) {
    this.tools = options.tools ?? builtinTools;
    this.maxSteps = options.maxSteps ?? 50;
    this.maxTokens = options.maxTokens ?? 8192;
    this.temperature = options.temperature;
    this.contextTokens = options.contextTokens ?? 200_000;
    this.approve = options.approve;
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
        let stepUsage: Usage = { ...EMPTY_USAGE };
        let doneReason: string = "stop";

        try {
          for await (const event of this.options.provider.stream({
            model: this.options.model,
            system: this.options.system,
            messages: session.messages,
            tools: this.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            })),
            maxTokens: this.maxTokens,
            ...(this.temperature !== undefined ? { temperature: this.temperature } : {}),
            ...(signal ? { signal } : {}),
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
          yield {
            type: "error",
            message: errorMessage(error),
            recoverable: false,
            ...(error instanceof ToolError && error.hint ? { hint: error.hint } : {}),
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

        for (const call of toolCalls) {
          if (signal?.aborted) {
            aborted = true;
            break;
          }

          const started = Date.now();
          const tool = findTool(call.name, this.tools);

          if (!tool) {
            const content = `Unknown tool "${call.name}". Available tools: ${this.tools
              .map((candidate) => candidate.name)
              .join(", ")}.`;
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
          try {
            content = await tool.execute(input, {
              cwd: this.options.cwd,
              ...(signal ? { signal } : {}),
              approve: this.approve,
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
    const size = () =>
      this.options.session.messages.reduce((total, message) => {
        const toolChars =
          message.role === "assistant"
            ? (message.toolCalls ?? []).reduce((sum, call) => sum + call.arguments.length, 0)
            : 0;
        return total + message.content.length + toolChars;
      }, 0);

    let removed = 0;
    let current = size();

    while (current > budgetChars && this.options.session.messages.length > 6) {
      const nextUser = this.options.session.messages.findIndex(
        (message, index) => index > 0 && message.role === "user",
      );
      if (nextUser <= 0) break;

      this.options.session.messages.splice(0, nextUser);
      removed += nextUser;
      current = size();
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
