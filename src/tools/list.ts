import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import type { Tool } from "./types.js";
import { optionalNumber, optionalString, requireString, resolvePath } from "./util.js";
import { formatBytes } from "../util/text.js";

interface ListEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modified: string;
}

export const listTool: Tool = {
  name: "list",
  readOnly: true,
  description: [
    "List the contents of a directory.",
    "Returns files and subdirectories with sizes and modification times.",
    "Sorted alphabetically; directories listed first.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path (absolute or relative to the working directory). Defaults to the working directory." },
      limit: { type: "number", description: "Maximum number of entries to return (default 200, max 1000)." },
    },
    required: [],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const root = resolvePath(ctx.cwd, optionalString(input, "path") ?? ".");
    const limit = Math.min(Math.max(Math.trunc(optionalNumber(input, "limit") ?? 200), 1), 1000);

    let stat;
    try {
      stat = await fs.stat(root);
    } catch {
      throw new ToolError(`Directory not found: ${root}`);
    }
    if (!stat.isDirectory()) {
      throw new ToolError(`${root} is not a directory.`, "Use read to read a file instead.");
    }

    const entries = await fs.readdir(root, { withFileTypes: true });
    const list: ListEntry[] = [];

    for (const entry of entries) {
      const absolute = path.join(root, entry.name);
      try {
        const info = await fs.stat(absolute);
        list.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          size: info.size,
          modified: new Date(info.mtimeMs).toISOString().slice(0, 19).replace("T", " "),
        });
      } catch {
        // file vanished between read and stat; ignore
      }
    }

    // Directories first, then alphabetical
    list.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    const selected = list.slice(0, limit);
    const lines = selected.map((entry) => {
      const typeMarker = entry.type === "directory" ? "/" : " ";
      const size = entry.type === "directory" ? "<dir>" : formatBytes(entry.size);
      return `  ${typeMarker}  ${size.padStart(10)}  ${entry.modified}  ${entry.name}`;
    });

    const more = list.length > selected.length ? `\n… ${list.length - selected.length} more entries (raise limit to see them).` : "";
    return `${list.length} entr${list.length === 1 ? "y" : "ies"} in ${root}:\n${lines.join("\n")}${more}`;
  },
};
