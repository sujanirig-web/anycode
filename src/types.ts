export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as emitted by the model. */
  arguments: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export const EMPTY_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};

export function addUsage(a: Usage, b: Partial<Usage>): Usage {
  return {
    inputTokens: a.inputTokens + (b.inputTokens ?? 0),
    outputTokens: a.outputTokens + (b.outputTokens ?? 0),
    cacheReadTokens: a.cacheReadTokens + (b.cacheReadTokens ?? 0),
    cacheWriteTokens: a.cacheWriteTokens + (b.cacheWriteTokens ?? 0),
  };
}

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; isError?: boolean };

export type JsonSchema = Record<string, unknown>;

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/**
 * Normalized provider events. Providers translate their wire format into this
 * stream so the agent loop never needs to know which vendor it is talking to.
 */
export type ProviderEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "tool_call"; call: ToolCall }
  | { type: "usage"; usage: Partial<Usage> }
  | {
      type: "done";
      reason: "stop" | "tool_calls" | "length" | "content_filter" | "error";
      message?: string;
    };

export interface ProviderRequest {
  model: string;
  system: string;
  messages: Message[];
  tools: ToolSchema[];
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  /** Whether a missing API key should be treated as a configuration error. */
  readonly requiresApiKey: boolean;
  stream(request: ProviderRequest): AsyncGenerator<ProviderEvent>;
}
