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

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
  id?: string;
  label?: string;
  requiresApiKey?: boolean;
  extraHeaders?: Record<string, string>;
}

interface ToolCallBuffer {
  id: string;
  name: string;
  args: string;
}

function isLocalURL(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "0.0.0.0" || host === "::1";
  } catch {
    return false;
  }
}

export function toOpenAIMessages(
  system: string,
  messages: Message[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [{ role: "system", content: system }];

  for (const message of messages) {
    if (message.role === "system") continue;

    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
      continue;
    }

    if (message.role === "assistant") {
      const toolCalls = message.toolCalls ?? [];
      const entry: Record<string, unknown> = {
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
      };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments || "{}" },
        }));
      }
      out.push(entry);
      continue;
    }

    out.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: message.content,
    });
  }

  return out;
}

function usesCompletionTokens(model: string): boolean {
  return /^(o1|o3|o4|gpt-5|codex)/i.test(model);
}

export class OpenAIProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly requiresApiKey: boolean;
  private readonly baseURL: string;
  private readonly apiKey?: string;
  private readonly extraHeaders: Record<string, string>;

  constructor(options: OpenAIProviderOptions = {}) {
    this.id = options.id ?? "openai";
    this.label = options.label ?? "OpenAI";
    this.baseURL = (options.baseURL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.extraHeaders = options.extraHeaders ?? {};
    this.requiresApiKey = options.requiresApiKey ?? !isLocalURL(this.baseURL);
  }

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    if (this.requiresApiKey && !this.apiKey) {
      throw new ProviderError(
        `No API key configured for ${this.label}. Set ANYCODE_API_KEY or the provider-specific key.`,
        401,
      );
    }

    const headers: Record<string, string> = { ...this.extraHeaders };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;

    const tools = request.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));

    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAIMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) body.tools = tools;
    if (usesCompletionTokens(request.model)) {
      body.max_completion_tokens = request.maxTokens;
    } else {
      body.max_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined && !usesCompletionTokens(request.model)) {
      body.temperature = request.temperature;
    }

    const response = await postStream({
      url: `${this.baseURL}/chat/completions`,
      headers,
      body,
      signal: request.signal,
    });

    if (!response.body) {
      throw new ProviderError("Provider returned an empty stream");
    }

    const buffers = new Map<number, ToolCallBuffer>();
    let finishReason: string | undefined;

    for await (const event of parseSSE(response.body)) {
      if (event.data === "[DONE]") break;
      if (!event.data.trim()) continue;

      let chunk: Record<string, any>;
      try {
        chunk = JSON.parse(event.data) as Record<string, any>;
      } catch {
        continue;
      }

      if (chunk.error) {
        const message =
          typeof chunk.error === "string" ? chunk.error : (chunk.error.message ?? "unknown error");
        throw new ProviderError(`Provider error: ${message}`);
      }

      const choice = chunk.choices?.[0];
      if (choice) {
        const delta = choice.delta ?? {};

        if (typeof delta.content === "string" && delta.content.length > 0) {
          yield { type: "text", text: delta.content };
        }

        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === "string" && reasoning.length > 0) {
          yield { type: "reasoning", text: reasoning };
        }

        if (Array.isArray(delta.tool_calls)) {
          for (const toolDelta of delta.tool_calls as Array<Record<string, any>>) {
            const index = typeof toolDelta.index === "number" ? toolDelta.index : 0;
            const buffer = buffers.get(index) ?? { id: "", name: "", args: "" };
            if (typeof toolDelta.id === "string" && toolDelta.id) buffer.id = toolDelta.id;
            if (typeof toolDelta.function?.name === "string") {
              buffer.name += toolDelta.function.name;
            }
            if (typeof toolDelta.function?.arguments === "string") {
              buffer.args += toolDelta.function.arguments;
            }
            buffers.set(index, buffer);
          }
        }

        if (typeof choice.finish_reason === "string") {
          finishReason = choice.finish_reason;
        }
      }

      if (chunk.usage) {
        const usage: Partial<Usage> = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
          cacheReadTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
        };
        yield { type: "usage", usage };
      }
    }

    for (const [index, buffer] of [...buffers.entries()].sort((a, b) => a[0] - b[0])) {
      if (!buffer.name) continue;
      const call: ToolCall = {
        id: buffer.id || `call_${index}_${Date.now()}`,
        name: buffer.name,
        arguments: buffer.args || "{}",
      };
      yield { type: "tool_call", call };
    }

    let reason: "stop" | "tool_calls" | "length" | "content_filter" = "stop";
    if (finishReason === "length") reason = "length";
    else if (finishReason === "content_filter") reason = "content_filter";
    else if (buffers.size > 0 || finishReason === "tool_calls") reason = "tool_calls";

    yield { type: "done", reason };
  }
}
