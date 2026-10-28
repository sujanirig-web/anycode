/*
┌──────────────────────────────────────────────────────────────────┐
│ test/providers.test.ts — Anthropic, OpenAI provider streaming      │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";

import { AnthropicProvider, toAnthropicMessages } from "../src/llm/anthropic.js";
import { OpenAIProvider, toOpenAIMessages } from "../src/llm/openai.js";
import type { Message, ProviderEvent, ProviderRequest } from "../src/types.js";

function baseRequest(overrides: Partial<ProviderRequest> = {}): ProviderRequest {
  return {
    model: "test-model",
    system: "You are a test.",
    messages: [{ role: "user", content: "hello" }],
    tools: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    ],
    maxTokens: 256,
    ...overrides,
  };
}

async function collect(stream: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function textOf(events: ProviderEvent[]): string {
  return events
    .filter((event): event is Extract<ProviderEvent, { type: "text" }> => event.type === "text")
    .map((event) => event.text)
    .join("");
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => resolve(body));
  });
}

async function startServer(
  handler: (request: http.IncomingMessage, response: http.ServerResponse, body: string) => void,
): Promise<{ baseURL: string; close: () => Promise<void> }> {
  const server = http.createServer(async (request, response) => {
    const body = await readBody(request);
    handler(request, response, body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("message conversion", () => {
  it("maps neutral history to OpenAI chat messages", () => {
    const messages: Message[] = [
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read", arguments: '{"path":"a.ts"}' }],
      },
      { role: "tool", toolCallId: "call_1", name: "read", content: "contents" },
    ];

    const converted = toOpenAIMessages("sys", messages);
    assert.equal(converted[0]?.role, "system");
    assert.equal(converted[1]?.role, "user");
    assert.equal(converted[2]?.role, "assistant");
    assert.equal((converted[2]?.tool_calls as unknown[]).length, 1);
    assert.equal(converted[3]?.role, "tool");
    assert.equal(converted[3]?.tool_call_id, "call_1");
  });

  it("merges Anthropic tool results into user messages", () => {
    const messages: Message[] = [
      { role: "user", content: "read both" },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "t1", name: "read", arguments: '{"path":"a.ts"}' },
          { id: "t2", name: "read", arguments: '{"path":"b.ts"}' },
        ],
      },
      { role: "tool", toolCallId: "t1", name: "read", content: "A" },
      { role: "tool", toolCallId: "t2", name: "read", content: "B" },
      { role: "assistant", content: "done" },
      { role: "user", content: "thanks" },
    ];

    const converted = toAnthropicMessages(messages);
    assert.equal(converted.length, 5);
    assert.equal(converted[0]?.role, "user");
    assert.equal(converted[1]?.role, "assistant");
    assert.equal(converted[2]?.role, "user");
    assert.equal(converted[2]?.content.length, 2);
    assert.equal(converted[2]?.content[0]?.type, "tool_result");
    assert.equal(converted[2]?.content[1]?.type, "tool_result");
  });

  it("ensures an Anthropic conversation starts with a user turn", () => {
    const converted = toAnthropicMessages([{ role: "assistant", content: "hello" }]);
    assert.equal(converted[0]?.role, "user");
    assert.equal(converted[1]?.role, "assistant");
  });
});

describe("OpenAI provider", () => {
  it("streams text deltas and a stop reason", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const server = await startServer((_request, response, body) => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n');
      response.write('data: {"choices":[{"delta":{"content":"lo"},"finish_reason":"stop"}]}\n\n');
      response.write("data: [DONE]\n\n");
      response.end();
    });

    try {
      const provider = new OpenAIProvider({ baseURL: server.baseURL, apiKey: "test" });
      const events = await collect(provider.stream(baseRequest()));

      assert.equal(textOf(events), "Hello");
      assert.ok(events.some((event) => event.type === "done" && event.reason === "stop"));
      assert.equal(bodies[0]?.model, "test-model");
      assert.equal((bodies[0]?.stream as boolean), true);
    } finally {
      await server.close();
    }
  });

  it("assembles tool calls from partial JSON deltas", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"pa"}}]}}]}\n\n',
      );
      response.write(
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n',
      );
      response.write('data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n');
      response.write("data: [DONE]\n\n");
      response.end();
    });

    try {
      const provider = new OpenAIProvider({ baseURL: server.baseURL, apiKey: "test" });
      const events = await collect(provider.stream(baseRequest()));
      const call = events.find(
        (event): event is Extract<ProviderEvent, { type: "tool_call" }> =>
          event.type === "tool_call",
      );

      assert.ok(call);
      assert.equal(call.call.id, "call_1");
      assert.equal(call.call.name, "read");
      assert.deepEqual(JSON.parse(call.call.arguments), { path: "a.txt" });
      assert.ok(events.some((event) => event.type === "done" && event.reason === "tool_calls"));
    } finally {
      await server.close();
    }
  });

  it("surfaces HTTP errors with status and message", async () => {
    const server = await startServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "bad key" } }));
    });

    try {
      const provider = new OpenAIProvider({ baseURL: server.baseURL, apiKey: "nope" });
      await assert.rejects(collect(provider.stream(baseRequest())), /401.*bad key/);
    } finally {
      await server.close();
    }
  });
});

describe("Anthropic provider", () => {
  it("streams text, usage and tool calls", async () => {
    let captured: Record<string, unknown> | undefined;
    const server = await startServer((request, response, body) => {
      assert.equal(request.url, "/v1/messages");
      captured = JSON.parse(body) as Record<string, unknown>;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
      );
      response.write(
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      );
      response.write(
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi "}}\n\n',
      );
      response.write('data: {"type":"content_block_stop","index":0}\n\n');
      response.write(
        'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n',
      );
      response.write(
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}\n\n',
      );
      response.write(
        'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"a.txt\\"}"}}\n\n',
      );
      response.write('data: {"type":"content_block_stop","index":1}\n\n');
      response.write(
        'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":9}}\n\n',
      );
      response.write('data: {"type":"message_stop"}\n\n');
      response.end();
    });

    try {
      const provider = new AnthropicProvider({ baseURL: server.baseURL, apiKey: "test" });
      const events = await collect(provider.stream(baseRequest()));

      assert.equal(textOf(events), "Hi ");
      const call = events.find(
        (event): event is Extract<ProviderEvent, { type: "tool_call" }> =>
          event.type === "tool_call",
      );
      assert.ok(call);
      assert.equal(call.call.name, "read");
      assert.deepEqual(JSON.parse(call.call.arguments), { path: "a.txt" });

      const usage = events.filter(
        (event): event is Extract<ProviderEvent, { type: "usage" }> => event.type === "usage",
      );
      assert.equal(usage.reduce((total, event) => total + (event.usage.inputTokens ?? 0), 0), 12);
      assert.ok(events.some((event) => event.type === "done" && event.reason === "tool_calls"));

      assert.ok(Array.isArray(captured?.tools));
      assert.equal(captured?.max_tokens, 256);
    } finally {
      await server.close();
    }
  });
});
