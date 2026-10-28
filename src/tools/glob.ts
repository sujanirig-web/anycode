import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import { globToRegExp, toPosix, walkFiles } from "../util/glob.js";
import { truncateEnd } from "../util/text.js";
import type { Tool } from "./types.js";
import { displayPath, optionalNumber, optionalString, requireString, resolvePath } from "./util.js";

interface Match {
  absolute: string;
  mtime: number;
}

export const globTool: Tool = {
  name: "glob",
  readOnly: true,
  description: [
    "Find files by glob pattern, sorted by modification time (newest first).",
    "Patterns are matched against paths relative to the search directory.",
    "Use ** for recursive matching, e.g. **/*.ts or src/**/*.{ts,tsx}.",
    "Results are capped at the limit (default 100).",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: 'Glob pattern, e.g. "**/*.ts".' },
      path: { type: "string", description: "Directory to search. Defaults to the working directory." },
      limit: { type: "number", description: "Maximum number of paths to return (default 100, max 500)." },
    },
    required: ["pattern"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const pattern = requireString(input, "pattern");
    const root = resolvePath(ctx.cwd, optionalString(input, "path") ?? ".");
    const limit = Math.min(Math.max(Math.trunc(optionalNumber(input, "limit") ?? 100), 1), 500);

    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      throw new ToolError(`Search path not found: ${displayPath(ctx.cwd, root)}`);
    }

    const matcher = globToRegExp(pattern);
    const matches: Match[] = [];

    const consider = async (absolute: string, relative: string) => {
      if (!matcher.test(toPosix(relative))) return;
      try {
        const info = await fs.stat(absolute);
        if (info.isFile()) matches.push({ absolute, mtime: info.mtimeMs });
      } catch {
        // file vanished between walk and stat; ignore
      }
    };

    if (stat.isFile()) {
      await consider(root, path.basename(root));
    } else {
      for await (const file of walkFiles(root, { signal: ctx.signal, maxFiles: 25_000 })) {
        await consider(file, path.relative(root, file));
        if (matches.length >= 5_000) break;
      }
    }

    matches.sort((a, b) => b.mtime - a.mtime);
    const selected = matches.slice(0, limit);

    if (selected.length === 0) {
      return `No files matched "${pattern}" under ${displayPath(ctx.cwd, root)}.\nHint: use "**/${pattern.replace(/^\*\*\//, "")}" for recursive matching.`;
    }

    const lines = selected.map((match) => displayPath(ctx.cwd, match.absolute));
    const more = matches.length > selected.length ? `\n… ${matches.length - selected.length} more matches (raise limit to see them).` : "";
    return `${matches.length} file${matches.length === 1 ? "" : "s"} matched "${pattern}" (newest first):\n${lines.join("\n")}${more}`;
  },
};

export { truncateEnd };
