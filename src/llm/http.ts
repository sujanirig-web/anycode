import { ProviderError } from "../errors.js";
import { sleep } from "../util/text.js";

export interface StreamRequest {
  url: string;
  headers: Record<string, string>;
  body: unknown;
  signal?: AbortSignal;
  retries?: number;
}

function errorDetail(text: string): string {
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } | string; message?: string };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // fall through to raw text
  }
  return text.trim().slice(0, 500);
}

function hintFor(status: number): string | undefined {
  if (status === 401 || status === 403) {
    return "Check your API key (ANYCODE_API_KEY or the provider-specific environment variable).";
  }
  if (status === 404) {
    return "Check the base URL and model name.";
  }
  if (status === 429) {
    return "Rate limited. Retry shortly or switch models.";
  }
  return undefined;
}

/** POST a streaming request with retries on transient failures. */
export async function postStream(request: StreamRequest): Promise<Response> {
  const attempts = (request.retries ?? 2) + 1;
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (request.signal?.aborted) throw new Error("aborted");
    try {
      const response = await fetch(request.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...request.headers,
        },
        body: JSON.stringify(request.body),
        signal: request.signal,
      });

      if (response.ok) return response;

      const text = await response.text().catch(() => "");
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < attempts - 1) {
        lastError = new ProviderError(
          `HTTP ${response.status}: ${errorDetail(text)}`,
          response.status,
        );
        await sleep(500 * 2 ** attempt + Math.random() * 250, request.signal);
        continue;
      }

      throw new ProviderError(
        `HTTP ${response.status}: ${errorDetail(text) || response.statusText}`,
        response.status,
      );
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      if (request.signal?.aborted) throw error;

      lastError = error;
      if (attempt < attempts - 1) {
        await sleep(500 * 2 ** attempt + Math.random() * 250, request.signal);
        continue;
      }
      throw new ProviderError(
        `Request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw lastError instanceof Error ? lastError : new ProviderError("Request failed");
}

export { hintFor };
