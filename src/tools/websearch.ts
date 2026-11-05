import { ToolError } from "../errors.js";
import { clamp } from "../util/text.js";
import type { Tool } from "./types.js";
import { limitOutput, optionalNumber, requireString } from "./util.js";

const DEFAULT_ENDPOINT = "https://html.duckduckgo.com/html/";
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;
const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_OUTPUT = 20_000;

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchOptions {
  /** Maximum number of results to return (1-10). Defaults to 5. */
  maxResults?: number;
  /** Endpoint that accepts a `q` query parameter and returns DuckDuckGo HTML. */
  endpoint?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface WebsearchToolOptions {
  /** Override the search endpoint (used by tests and self-hosted mirrors). */
  endpoint?: string;
  timeoutMs?: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  copy: "©",
};

export function decodeEntities(text: string): string {
  return text.replace(
    /&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]+);/g,
    (match, entity: string) => {
      if (entity.startsWith("#")) {
        const hex = entity[1]?.toLowerCase() === "x";
        const value = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        if (Number.isFinite(value) && value >= 0 && value <= 0x10ffff) {
          return String.fromCodePoint(value);
        }
        return match;
      }
      return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
    },
  );
}

function plainText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ""))
    .replace(/\s+/g, " ")
    .trim();
}

function extractAttribute(attrs: string, name: string): string | undefined {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const match = pattern.exec(attrs);
  if (!match) return undefined;
  return match[2] ?? match[3] ?? "";
}

function hasClass(attrs: string, className: string): boolean {
  const value = extractAttribute(attrs, "class");
  if (!value) return false;
  return value.split(/\s+/).includes(className);
}

interface Block {
  start: number;
  end: number;
  attrs: string;
  inner: string;
}

function collectBlocks(html: string, className: string): Block[] {
  const blocks: Block[] = [];
  const lower = html.toLowerCase();
  // Scan opening tags only, so a parent element's content is never swallowed.
  const pattern = /<(a|div)\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const tag = (match[1] ?? "").toLowerCase();
    const attrs = match[2] ?? "";
    if (!hasClass(attrs, className)) continue;

    const closeTag = `</${tag}>`;
    const closeIndex = lower.indexOf(closeTag, pattern.lastIndex);
    if (closeIndex === -1) continue;

    blocks.push({
      start: match.index,
      end: closeIndex + closeTag.length,
      attrs,
      inner: html.slice(pattern.lastIndex, closeIndex),
    });
  }
  return blocks;
}

/** Resolve DuckDuckGo redirect links (`/l/?uddg=...`) to their target URL. */
export function normalizeResultUrl(href: string): string {
  const raw = decodeEntities(href).trim();
  if (raw.length === 0) return "";

  let parsed: URL;
  try {
    parsed = new URL(raw, "https://duckduckgo.com");
  } catch {
    return raw;
  }

  const isRedirect =
    (parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")) &&
    parsed.pathname.startsWith("/l/");
  if (isRedirect) {
    const target = parsed.searchParams.get("uddg")?.trim();
    if (target) return target.startsWith("//") ? `https:${target}` : target;
  }

  return parsed.toString();
}

function isResultUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    // Skip DuckDuckGo's own ad/redirect endpoints (`/y.js`, tracking pages).
    return !(
      parsed.hostname === "duckduckgo.com" || parsed.hostname.endsWith(".duckduckgo.com")
    );
  } catch {
    return false;
  }
}

/** Parse the result list out of a DuckDuckGo HTML results page. */
export function parseDuckDuckGoHtml(html: string): SearchResult[] {
  const anchors = collectBlocks(html, "result__a");
  const snippets = collectBlocks(html, "result__snippet");
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  anchors.forEach((anchor, index) => {
    const href = extractAttribute(anchor.attrs, "href");
    if (!href) return;

    const url = normalizeResultUrl(href);
    if (!isResultUrl(url) || seen.has(url)) return;

    const title = plainText(anchor.inner);
    if (title.length === 0) return;

    const nextStart = anchors[index + 1]?.start ?? Number.POSITIVE_INFINITY;
    const snippetBlock = snippets.find(
      (candidate) => candidate.start > anchor.end && candidate.start < nextStart,
    );
    const snippet = snippetBlock ? plainText(snippetBlock.inner) : "";

    seen.add(url);
    results.push({ title, url, snippet });
  });

  return results;
}

/** Search the web through DuckDuckGo's keyless HTML endpoint. */
export async function searchWeb(
  query: string,
  options: SearchOptions = {},
): Promise<SearchResult[]> {
  if (options.signal?.aborted) {
    throw new ToolError("Search aborted.");
  }

  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const maxResults = clamp(Math.trunc(options.maxResults ?? DEFAULT_RESULTS), 1, MAX_RESULTS);
  const timeoutMs = Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const url = new URL(endpoint);
    url.searchParams.set("q", query);

    const response = await fetch(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new ToolError(
        `Search request failed with HTTP ${response.status}.`,
        "Check the network connection and retry, or narrow the query.",
      );
    }

    const html = await response.text();
    return parseDuckDuckGoHtml(html).slice(0, maxResults);
  } catch (error) {
    if (options.signal?.aborted) {
      throw new ToolError("Search aborted.");
    }
    if (timedOut) {
      throw new ToolError(
        `Search timed out after ${timeoutMs}ms.`,
        "Check the network connection and retry with a narrower query.",
      );
    }
    if (error instanceof ToolError) throw error;

    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(
      `Search request failed: ${message}`,
      "Check the network connection and retry.",
    );
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

export function createWebsearchTool(options: WebsearchToolOptions = {}): Tool {
  return {
    name: "websearch",
    readOnly: true,
    description: [
      "Search the web with DuckDuckGo and return titles, URLs and snippets.",
      "Use it for current events, external documentation, library versions and facts that are not in the repository.",
      "Cite the URLs you used in your answer.",
      `Results are capped at max_results (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS}).`,
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        max_results: {
          type: "number",
          description: `Maximum number of results to return (default ${DEFAULT_RESULTS}, max ${MAX_RESULTS}).`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },

    async execute(input, ctx) {
      const query = requireString(input, "query").trim();
      if (query.length === 0) {
        throw new ToolError('Argument "query" must not be blank.');
      }

      const maxResults = clamp(
        Math.trunc(optionalNumber(input, "max_results") ?? DEFAULT_RESULTS),
        1,
        MAX_RESULTS,
      );

      const results = await searchWeb(query, {
        maxResults,
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });

      if (results.length === 0) {
        return `No web results for "${query}".\nHint: try fewer or different keywords, or retry in a moment.`;
      }

      const body = results
        .map((result, index) => {
          const snippet = result.snippet ? `\n   ${result.snippet}` : "";
          return `${index + 1}. ${result.title}\n   ${result.url}${snippet}`;
        })
        .join("\n\n");

      return limitOutput(
        `Web results for "${query}":\n\n${body}`,
        MAX_OUTPUT,
      );
    },
  };
}

export const websearchTool: Tool = createWebsearchTool();
