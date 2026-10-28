import { promises as fs } from "node:fs";
import path from "node:path";

export function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeRe(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a glob pattern into a regular expression.
 * Supports `*`, `**`, `?`, `{a,b}` and `[abc]`. Paths are matched in posix form.
 */
export function globToRegExp(pattern: string): RegExp {
  const source = toPosix(pattern);
  let out = "";

  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;

    if (char === "*") {
      if (source[i + 1] === "*") {
        i++;
        if (source[i + 1] === "/") {
          i++;
          out += "(?:[^/]*(?:/|$))*";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }

    if (char === "?") {
      out += "[^/]";
      continue;
    }

    if (char === "[") {
      const end = source.indexOf("]", i + 1);
      if (end === -1) {
        out += "\\[";
        continue;
      }
      let body = source.slice(i + 1, end);
      if (body.startsWith("!")) body = `^${body.slice(1)}`;
      if (body.startsWith("^")) {
        out += `[${body.replace(/\\/g, "\\\\")}]`;
      } else {
        out += `[${body.replace(/\\/g, "\\\\")}]`;
      }
      i = end;
      continue;
    }

    if (char === "{") {
      const end = source.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        continue;
      }
      const parts = source.slice(i + 1, end).split(",");
      out += `(?:${parts.map(escapeRe).join("|")})`;
      i = end;
      continue;
    }

    out += escapeRe(char);
  }

  return new RegExp(`^${out}$`);
}

export function matchesGlob(relativePath: string, pattern: string | RegExp): boolean {
  const normalized = toPosix(relativePath).replace(/^\.\//, "");
  const re = typeof pattern === "string" ? globToRegExp(pattern) : pattern;
  return re.test(normalized);
}

export const DEFAULT_IGNORE = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  ".anycode",
  ".minicode",
  "target",
  "vendor",
];

export interface WalkOptions {
  ignore?: string[];
  maxFiles?: number;
  signal?: AbortSignal;
  /** Include dotfiles/dot-directories. Defaults to true (except ignored dirs). */
  includeHidden?: boolean;
}

/**
 * Recursively walk a directory yielding absolute file paths.
 * Symlinks are skipped to avoid cycles. Output order is filesystem order.
 */
export async function* walkFiles(
  root: string,
  options: WalkOptions = {},
): AsyncGenerator<string> {
  const ignore = new Set(options.ignore ?? DEFAULT_IGNORE);
  const maxFiles = options.maxFiles ?? 25_000;
  let seen = 0;

  async function* visit(directory: string): AsyncGenerator<string> {
    if (options.signal?.aborted) return;

    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (options.signal?.aborted) return;
      if (seen >= maxFiles) return;

      const name = entry.name;
      if (!options.includeHidden && name.startsWith(".")) continue;
      if (ignore.has(name)) continue;

      const full = path.join(directory, name);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        yield* visit(full);
      } else if (entry.isFile()) {
        seen++;
        yield full;
      }
    }
  }

  yield* visit(root);
}
