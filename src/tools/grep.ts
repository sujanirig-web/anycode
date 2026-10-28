import { spawn, spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import { globToRegExp, toPosix, walkFiles } from "../util/glob.js";
import { escapeRegExp, oneLine } from "../util/text.js";
import type { Tool } from "./types.js";
import {
  detectBinary,
  displayPath,
  optionalBoolean,
  optionalNumber,
  optionalString,
  requireString,
  resolvePath,
} from "./util.js";

interface Match {
  file: string;
  line: number;
  text: string;
}

let ripgrepAvailable: boolean | undefined;

function hasRipgrep(): boolean {
  if (ripgrepAvailable !== undefined) return ripgrepAvailable;
  try {
    const result = spawnSync("rg", ["--version"], { stdio: "ignore", windowsHide: true });
    ripgrepAvailable = result.status === 0;
  } catch {
    ripgrepAvailable = false;
  }
  return ripgrepAvailable;
}

export const grepTool: Tool = {
  name: "grep",
  readOnly: true,
  description: [
    "Search file contents with a regular expression and return file:line:text matches.",
    "Uses ripgrep when available and falls back to a built-in scanner.",
    "Set fixed_strings for literal text, include to restrict files (e.g. *.ts), ignore_case for case-insensitive search.",
    "Results are capped at max_results (default 100).",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression (or literal text when fixed_strings is true)." },
      path: { type: "string", description: "File or directory to search. Defaults to the working directory." },
      include: { type: "string", description: 'Comma-separated glob filter, e.g. "*.ts" or "*.ts,*.tsx".' },
      ignore_case: { type: "boolean", description: "Case-insensitive matching." },
      fixed_strings: { type: "boolean", description: "Treat pattern as literal text." },
      max_results: { type: "number", description: "Maximum matches to return (default 100, max 500)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const pattern = requireString(input, "pattern");
    const root = resolvePath(ctx.cwd, optionalString(input, "path") ?? ".");
    const include = optionalString(input, "include");
    const ignoreCase = optionalBoolean(input, "ignore_case") ?? false;
    const fixed = optionalBoolean(input, "fixed_strings") ?? false;
    const maxResults = Math.min(
      Math.max(Math.trunc(optionalNumber(input, "max_results") ?? 100), 1),
      500,
    );

    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      throw new ToolError(`Search path not found: ${displayPath(ctx.cwd, root)}`);
    }

    if (stat.isFile()) {
      const matches = await scanFile(root, pattern, { ignoreCase, fixed, maxResults });
      return formatMatches(matches, pattern, maxResults, ctx.cwd);
    }

    if (hasRipgrep()) {
      return searchWithRipgrep(root, pattern, {
        include,
        ignoreCase,
        fixed,
        maxResults,
        cwd: ctx.cwd,
        signal: ctx.signal,
      });
    }

    return searchWithNode(root, pattern, {
      include,
      ignoreCase,
      fixed,
      maxResults,
      cwd: ctx.cwd,
      signal: ctx.signal,
    });
  },
};

function buildRegExp(pattern: string, options: { ignoreCase: boolean; fixed: boolean }): RegExp {
  const source = options.fixed ? escapeRegExp(pattern) : pattern;
  try {
    return new RegExp(source, options.ignoreCase ? "i" : "");
  } catch (error) {
    throw new ToolError(
      `Invalid regular expression: ${(error as Error).message}`,
      "Fix the pattern or set fixed_strings=true.",
    );
  }
}

async function scanFile(
  file: string,
  pattern: string,
  options: { ignoreCase: boolean; fixed: boolean; maxResults: number },
): Promise<Match[]> {
  let buffer: Buffer;
  try {
    const info = await fs.stat(file);
    if (info.size > 2 * 1024 * 1024) return [];
    buffer = await fs.readFile(file);
  } catch {
    return [];
  }
  if (detectBinary(buffer)) return [];

  const regex = buildRegExp(pattern, options);
  const matches: Match[] = [];
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i]!)) {
      matches.push({ file, line: i + 1, text: oneLine(lines[i]!, 300) });
      if (matches.length >= options.maxResults) break;
    }
  }
  return matches;
}

function formatMatches(matches: Match[], pattern: string, maxResults: number, cwd: string): string {
  if (matches.length === 0) {
    return `No matches for "${pattern}".\nHint: check the pattern, the search path, or try ignore_case=true.`;
  }
  const lines = matches.map(
    (match) => `${displayPath(cwd, match.file)}:${match.line}: ${match.text}`,
  );
  const files = new Set(matches.map((match) => match.file)).size;
  const suffix =
    matches.length >= maxResults ? `\n… stopped at max_results=${maxResults}.` : "";
  return `${matches.length} match${matches.length === 1 ? "" : "es"} in ${files} file${files === 1 ? "" : "s"}:\n${lines.join("\n")}${suffix}`;
}

interface SearchOptions {
  include?: string;
  ignoreCase: boolean;
  fixed: boolean;
  maxResults: number;
  cwd: string;
  signal?: AbortSignal;
}

function searchWithRipgrep(
  root: string,
  pattern: string,
  options: SearchOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ["--json", "--line-number", "--color", "never", "--max-columns", "500", "--max-filesize", "2M"];
    if (options.ignoreCase) args.push("-i");
    if (options.fixed) args.push("-F");
    if (options.include) {
      for (const glob of options.include.split(",")) {
        const trimmed = glob.trim();
        if (trimmed) args.push("--glob", trimmed);
      }
    }
    args.push("-e", pattern, "--", root);

    const child = spawn("rg", args, { windowsHide: true, signal: options.signal });
    let stdout = "";
    let stderr = "";
    const cap = 8 * 1024 * 1024;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < cap) stdout += chunk.toString("utf8");
      if (stdout.length >= cap) child.kill();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 20_000) stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(new ToolError(`ripgrep failed: ${error.message}`));
    });

    child.on("close", (code) => {
      if (code === 2) {
        reject(new ToolError(`ripgrep failed: ${stderr.trim() || "unknown error"}`));
        return;
      }

      const matches: Match[] = [];
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== "match") continue;
        const file = event.data?.path?.text;
        if (typeof file !== "string") continue;
        const text = String(event.data?.lines?.text ?? "").replace(/\r?\n$/, "");
        matches.push({
          file,
          line: Number(event.data?.line_number ?? 0),
          text: oneLine(text, 300),
        });
        if (matches.length >= options.maxResults) break;
      }

      resolve(formatMatches(matches, pattern, options.maxResults, options.cwd));
    });
  });
}

async function searchWithNode(
  root: string,
  pattern: string,
  options: SearchOptions,
): Promise<string> {
  const regex = buildRegExp(pattern, options);
  const includes = options.include
    ? options.include.split(",").map((glob) => globToRegExp(glob.trim())).filter(Boolean)
    : [];
  const matches: Match[] = [];

  for await (const file of walkFiles(root, { signal: options.signal })) {
    if (matches.length >= options.maxResults) break;
    if (includes.length > 0) {
      const relative = toPosix(path.relative(root, file));
      const name = path.basename(file);
      const matched = includes.some((re) => re.test(relative) || re.test(name));
      if (!matched) continue;
    }
    const found = await scanFile(file, pattern, {
      ignoreCase: options.ignoreCase,
      fixed: options.fixed,
      maxResults: options.maxResults - matches.length,
    });
    matches.push(...found);
  }

  return formatMatches(matches, pattern, options.maxResults, options.cwd);
}
