import { promises as fs } from "node:fs";
import type { Tool } from "./types.js";
import {
  displayPath,
  limitOutput,
  optionalNumber,
  readTextFile,
  requireString,
  resolvePath,
} from "./util.js";

const MAX_LINES = 2000;

export const readTool: Tool = {
  name: "read",
  readOnly: true,
  description: [
    "Read a text file from the local filesystem.",
    "Returns the file contents with 1-based line numbers, plus a header showing the line range.",
    "Use offset and limit to page through large files.",
    "Always read a file before editing it so the edit matches exactly.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to the working directory)." },
      offset: { type: "number", description: "1-based line number to start reading from. Defaults to 1." },
      limit: { type: "number", description: `Maximum number of lines to return (max ${MAX_LINES}). Defaults to ${MAX_LINES}.` },
    },
    required: ["path"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));
    const text = await readTextFile(target);
    const lines = text.split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

    const total = lines.length;
    const offset = Math.min(
      Math.max(Math.trunc(optionalNumber(input, "offset") ?? 1), 1),
      Math.max(total, 1),
    );
    const limit = Math.min(
      Math.max(Math.trunc(optionalNumber(input, "limit") ?? MAX_LINES), 1),
      MAX_LINES,
    );
    const end = Math.min(total, offset - 1 + limit);

    const width = String(end).length;
    const body: string[] = [];
    for (let i = offset - 1; i < end; i++) {
      body.push(`${String(i + 1).padStart(width)}| ${lines[i]}`);
    }

    const header = `${displayPath(ctx.cwd, target)} (lines ${offset}-${end} of ${total})`;
    if (body.length === 0) return `${header}\n(file is empty)`;

    const suffix =
      end < total ? `\n… ${total - end} more lines; use offset=${end + 1} to continue.` : "";
    return limitOutput(`${header}\n${body.join("\n")}${suffix}`, 120_000);
  },
};

export async function fileExists(target: string): Promise<boolean> {
  try {
    const stat = await fs.stat(target);
    return stat.isFile();
  } catch {
    return false;
  }
}
