import type { Provider, ProviderEvent, ProviderRequest } from "../types.js";

export type MockScript = (
  request: ProviderRequest,
  turn: number,
) => ProviderEvent[] | Promise<ProviderEvent[]>;

/** Deterministic provider used by tests and `--provider mock` demos. */
export class MockProvider implements Provider {
  readonly id = "mock";
  readonly label = "Mock";
  readonly requiresApiKey = false;
  private turn = 0;

  constructor(private readonly script: MockScript) {}

  async *stream(request: ProviderRequest): AsyncGenerator<ProviderEvent> {
    const events = await this.script(request, this.turn++);
    for (const event of events) yield event;
  }
}

export function textTurn(text: string): ProviderEvent[] {
  return [
    { type: "text", text },
    { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } },
    { type: "done", reason: "stop" },
  ];
}

export function toolTurn(
  call: { id?: string; name: string; arguments: string },
  text = "",
): ProviderEvent[] {
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    {
      type: "tool_call" as const,
      call: { id: call.id ?? "call_1", name: call.name, arguments: call.arguments },
    },
    { type: "usage" as const, usage: { inputTokens: 20, outputTokens: 10 } },
    { type: "done" as const, reason: "tool_calls" as const },
  ];
}
