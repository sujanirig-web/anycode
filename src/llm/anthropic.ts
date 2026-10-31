import { ProviderError } from "../errors.js";
import type {
  Message,
  Provider,
  ProviderEvent,
  ProviderRequest,
  ToolCall,
  Usage,
} from "../types.js";
import { parseSSE } from "../util/sse.js";
import { postStream } from "./http.js";

export interface AnthropicProviderOptions {
  apiKey?: string;
  baseURL?: string;
  label?: string;
}

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicBlock[];
}

function parseArguments(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return {};
  }
}

/**
 * Convert the provider-neutral history into Anthropic's block format.
 * Tool results must live inside `user` messages, and consecutive turns of the
 * same role are merged because the API requires alternating roles.
 */
export function toAnthropicMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];

  const pushBlocks = (role: "user" | "assistant", blocks: AnthropicBlock[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) {
      last.content.push(...blocks);
    } else {
      out.push({ role, content: [...blocks] });
    }
  };

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      pushBlocks("user", [{ type: "text", text: message.content }]);
      continue;
    }

    if (message.role === "assistant") {
      const blocks: AnthropicBlock[] = [];
      if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: parseArguments(call.arguments),
        });
      }
      if (blocks.length === 0) blocks.push({ type: "text", text: "(no content)" });
      pushBlocks("assistant", blocks);
      continue;
    }

    pushBlocks("user", [
      {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: message.content,
        ...(message.isError ? { is_error: true } : {}),
      },
    ]);
  }

  if (out.length === 0) {
    out.push({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }

  // The API expects the conversation to start with a user turn.
  if (out[0]!.role !== "user") {
    out.unshift({ role: "user", content: [{ type: "text", text: "Continue." }] });
  }

  return out;
}

interface ToolBuffer {
  id: string;
  name: string;
  json: string;
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly label: string;
  readonly requiresApiKey = true;
  private readonly baseURL: string;
  private readonly apiKey?: string;

  constructor(options: AnthropicProviderOptions = {}) {
    this.baseURL = (options.baseURL ?? "https://api.anthropic.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.label = options.label ?? "Anthropic";
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    if (!this.apiKey) {
      throw new ProviderError(
        "No Anthropic API key configured. Set ANTHROPIC_API_KEY or ANYCODE_API_KEY.",
        401,
      );
    }

    const tools = request.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters,
    }));

    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: toAnthropicMessages(request.messages),
      stream: true,
    };
    if (tools.length > 0) body.tools = tools;
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.toolChoice === "required") body.tool_choice = { type: "required" };
    else if (request.toolChoice === "none") body.tool_choice = { type: "none" };
    else if (request.toolChoice === "auto") body.tool_choice = { type: "auto" };

    const response = await postStream({
      url: `${this.baseURL}/messages`,
      headers: {
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      signal: request.signal,
    });

    if (!response.body) {
      throw new ProviderError("Anthropic returned an empty stream");
    }

    const toolBuffers = new Map<number, ToolBuffer>();
    let stopReason: string | undefined;

    for await (const event of parseSSE(response.body)) {
      if (!event.data.trim()) continue;

      let data: Record<string, any>;
      try {
        data = JSON.parse(event.data) as Record<string, any>;
      } catch {
        continue;
      }

      switch (data.type) {
        case "message_start": {
          const usage = data.message?.usage;
          if (usage) {
            const partial: Partial<Usage> = {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            };
            yield { type: "usage", usage: partial };
          }
          break;
        }

        case "content_block_start": {
          const block = data.content_block;
          if (block?.type === "tool_use") {
            toolBuffers.set(data.index ?? 0, {
              id: block.id ?? `tool_${data.index ?? 0}`,
              name: block.name ?? "",
              json: "",
            });
          } else if (block?.type === "text" && typeof block.text === "string" && block.text) {
            yield { type: "text", text: block.text };
          }
          break;
        }

        case "content_block_delta": {
          const delta = data.delta ?? {};
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            yield { type: "text", text: delta.text };
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            const buffer = toolBuffers.get(data.index ?? 0);
            if (buffer) buffer.json += delta.partial_json;
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            yield { type: "reasoning", text: delta.thinking };
          }
          break;
        }

        case "content_block_stop": {
          const buffer = toolBuffers.get(data.index ?? 0);
          if (buffer) {
            const call: ToolCall = {
              id: buffer.id,
              name: buffer.name,
              arguments: buffer.json || "{}",
            };
            yield { type: "tool_call", call };
            toolBuffers.delete(data.index ?? 0);
          }
          break;
        }

        case "message_delta": {
          if (typeof data.delta?.stop_reason === "string") {
            stopReason = data.delta.stop_reason;
          }
          const outputTokens = data.usage?.output_tokens;
          if (typeof outputTokens === "number") {
            yield { type: "usage", usage: { outputTokens } };
          } else if (data.usage?.input_tokens) {
            yield { type: "usage", usage: { inputTokens: data.usage.input_tokens } };
          }
          break;
        }

        case "error": {
          const message = data.error?.message ?? "unknown error";
          throw new ProviderError(`Anthropic error: ${message}`);
        }

        default:
          break;
      }
    }

    let reason: "stop" | "tool_calls" | "length" | "content_filter" = "stop";
    if (stopReason === "tool_use") reason = "tool_calls";
    else if (stopReason === "max_tokens") reason = "length";
    else if (stopReason === "refusal") reason = "content_filter";

    yield { type: "done", reason };
  }
}
