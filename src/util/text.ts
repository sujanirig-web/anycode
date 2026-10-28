export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

/** Truncate in the middle so both the head and tail of long output survive. */
export function truncateMiddle(text: string, max: number, label = "truncated"): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = Math.max(0, max - head - 40);
  const removed = text.length - head - tail;
  return `${text.slice(0, head)}\n… [${label}: ${formatNumber(removed)} chars] …\n${
    tail > 0 ? text.slice(-tail) : ""
  }`;
}

export function truncateEnd(text: string, max: number, label = "truncated"): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n… [${label}: ${formatNumber(text.length - max)} chars]`;
}

export function oneLine(text: string, max = 120): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return count === 1 ? singular : plural;
}

export function estimateTokens(text: string): number {
  // Cheap heuristic: ~4 chars per token for latin text. Good enough for budgets.
  return Math.ceil(text.length / 4);
}

export interface JsonParseResult<T> {
  ok: boolean;
  value?: T;
  error?: string;
}

export function safeJsonParse<T = unknown>(text: string): JsonParseResult<T> {
  try {
    return { ok: true, value: JSON.parse(text) as T };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function relativeTo(cwd: string, target: string): string {
  if (!target.startsWith(cwd)) return target;
  const rest = target.slice(cwd.length).replace(/^[\\/]+/, "");
  return rest.length === 0 ? "." : rest;
}

/** True when a buffer looks binary (NUL byte in the first 8 KiB). */
export function looksBinary(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function indent(text: string, prefix: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => (line.length > 0 ? prefix + line : line))
    .join("\n");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
