import os from "node:os";
import path from "node:path";
import { ToolError } from "../errors.js";
import { formatBytes, truncateMiddle } from "../util/text.js";

export function requireString(
  input: Record<string, unknown>,
  key: string,
  options: { allowEmpty?: boolean } = {},
): string {
  const value = input[key];
  if (typeof value !== "string") {
    throw new ToolError(`Missing required string argument "${key}".`);
  }
  if (!options.allowEmpty && value.length === 0) {
    throw new ToolError(`Argument "${key}" must not be empty.`);
  }
  return value;
}

export function optionalString(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = input[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function optionalNumber(
  input: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = input[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function optionalBoolean(
  input: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = input[key];
  return typeof value === "boolean" ? value : undefined;
}

export function resolvePath(cwd: string, input: string): string {
  let target = input.trim();
  if (target === "~") target = os.homedir();
  else if (target.startsWith("~/") || target.startsWith("~\\")) {
    target = path.join(os.homedir(), target.slice(2));
  }
  return path.isAbsolute(target) ? path.normalize(target) : path.resolve(cwd, target);
}

export function displayPath(cwd: string, absolute: string): string {
  const relative = path.relative(cwd, absolute);
  if (relative === "") return ".";
  if (relative.startsWith("..")) return absolute;
  return relative.replace(/\\/g, "/");
}

export function detectBinary(buffer: Uint8Array): boolean {
  const limit = Math.min(buffer.length, 8192);
  for (let i = 0; i < limit; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

export function limitOutput(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  return truncateMiddle(text, max, "output truncated");
}

export async function readTextFile(absolute: string): Promise<string> {
  const { promises: fs } = await import("node:fs");
  let stat;
  try {
    stat = await fs.stat(absolute);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ToolError(`File not found: ${absolute}`, "Check the path with glob or list the directory.");
    }
    if (code === "EACCES") {
      throw new ToolError(`Permission denied reading ${absolute}`);
    }
    throw new ToolError(`Could not read ${absolute}: ${(error as Error).message}`);
  }
  if (stat.isDirectory()) {
    throw new ToolError(`${absolute} is a directory, not a file.`, "Use glob to list directory contents.");
  }
  if (stat.size > 5 * 1024 * 1024) {
    throw new ToolError(
      `File is too large (${formatBytes(stat.size)}); read it in chunks with offset/limit.`,
    );
  }
  const buffer = await fs.readFile(absolute);
  if (detectBinary(buffer)) {
    throw new ToolError(`${absolute} looks like a binary file and cannot be read as text.`);
  }
  return buffer.toString("utf8");
}

export function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index === -1) return count;
    count++;
    index += needle.length;
  }
}
