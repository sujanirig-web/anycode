import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import type { Tool } from "./types.js";
import { limitOutput, optionalBoolean, requireString, resolvePath } from "./util.js";

export const deleteTool: Tool = {
  name: "delete",
  description: [
    "Delete a file or an empty directory.",
    "For directories, pass recursive=true to delete contents too (use with caution).",
    "The user is asked to approve before anything is deleted.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File or directory path (absolute or relative to the working directory)." },
      recursive: { type: "boolean", description: "Delete directory contents recursively. Defaults to false." },
    },
    required: ["path"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));
    const recursive = optionalBoolean(input, "recursive") ?? false;

    let stat;
    try {
      stat = await fs.stat(target);
    } catch {
      throw new ToolError(`Path not found: ${target}`);
    }

    const isDir = stat.isDirectory();
    const relative = path.relative(ctx.cwd, target) || target;

    // If it's a non-empty directory and not recursive, refuse.
    if (isDir && !recursive) {
      const entries = await fs.readdir(target);
      if (entries.length > 0) {
        throw new ToolError(
          `${relative} is a non-empty directory. Pass recursive=true to delete it and all contents, or delete files individually.`,
        );
      }
    }

    const approved = await ctx.approve({
      tool: "delete",
      kind: "delete",
      title: `Delete ${relative}${isDir ? " (directory)" : ""}${recursive ? " [recursive]" : ""}`,
      detail: isDir
        ? `Directory ${relative} (${await fs.readdir(target).then((e) => e.length)} entries)`
        : `File ${relative} (${stat.size} bytes)`,
    });
    if (!approved) {
      throw new ToolError("User denied permission to delete this path. Do not retry without asking.");
    }

    if (isDir && recursive) {
      await fs.rm(target, { recursive: true, force: true });
    } else {
      await fs.rm(target, { recursive: false, force: true });
    }

    return `Deleted ${relative}`;
  },
};
