import { UserError } from "../errors.js";
import type { Provider } from "../types.js";
import { AnthropicProvider } from "./anthropic.js";
import { OpenAIProvider } from "./openai.js";

export interface ProviderSettings {
  id: string;
  model: string;
  apiKey?: string;
  baseURL?: string;
}

export function createProvider(settings: ProviderSettings): Provider {
  switch (settings.id) {
    case "anthropic":
      return new AnthropicProvider({
        ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
        ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      });

    case "openai":
      return new OpenAIProvider({
        ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
        ...(settings.baseURL ? { baseURL: settings.baseURL } : {}),
      });

    case "openai-compatible":
    case "compatible":
      return new OpenAIProvider({
        id: "openai-compatible",
        label: "OpenAI-compatible",
        baseURL: settings.baseURL ?? "https://api.openai.com/v1",
        ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      });

    case "ollama":
      return new OpenAIProvider({
        id: "ollama",
        label: "Ollama",
        baseURL: settings.baseURL ?? "http://localhost:11434/v1",
        requiresApiKey: false,
        ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      });

    case "anyroute":
      return new OpenAIProvider({
        id: "anyroute",
        label: "AnyRoute",
        baseURL: settings.baseURL ?? "http://127.0.0.1:3456/v1",
        requiresApiKey: false,
        ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      });

    default:
      throw new UserError(
        `Unknown provider "${settings.id}". Use one of: anthropic, openai, openai-compatible, ollama, anyroute.`,
      );
  }
}

export { AnthropicProvider, OpenAIProvider };
export { MockProvider, textTurn, toolTurn } from "./mock.js";
export type { MockScript } from "./mock.js";
