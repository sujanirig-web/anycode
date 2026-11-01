import { ProviderError, errorMessage } from "../errors.js";

const CATALOG_TIMEOUT_MS = 5_000;

export async function fetchModelIds(
  providerId: string,
  baseURL: string,
  apiKey?: string,
): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    if (providerId === "anthropic") headers["x-api-key"] = apiKey;
    else headers.authorization = `Bearer ${apiKey}`;
  }
  if (providerId === "anthropic") headers["anthropic-version"] = "2023-06-01";

  const url = `${baseURL.replace(/\/+$/, "")}/models`;
  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ProviderError(
      `Could not reach the model catalog at ${url}: ${errorMessage(error)}`,
    );
  }

  if (!response.ok) {
    throw new ProviderError(
      `Model catalog request failed: HTTP ${response.status} ${response.statusText}`.trim(),
      response.status,
    );
  }

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  return (payload.data ?? []).flatMap((model) => model.id ? [model.id] : []);
}