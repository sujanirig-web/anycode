import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import type { Tool } from "./types.js";
import { fileExists } from "./read.js";
import { optionalBoolean, requireString, resolvePath } from "./util.js";
import { formatBytes } from "../util/text.js";

export const copyTool: Tool = {
  name: "copy",
  description: [
    "Copy a file or directory to a new location.",
    "Parent directories of the destination are created automatically.",
    "Directories are copied recursively.",
    "The user is asked to approve before anything is copied.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      source: { type: "string", description: "Source file or directory path (absolute or relative)." },
      destination: { type: "string", description: "Destination file or directory path (absolute or relative)." },
      overwrite: { type: "boolean", description: "Overwrite destination if it already exists. Defaults to false." },
    },
    required: ["source", "destination"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const source = resolvePath(ctx.cwd, requireString(input, "source"));
    const destination = resolvePath(ctx.cwd, requireString(input, "destination"));
    const overwrite = optionalBoolean(input, "overwrite") ?? false;

    let stat;
    try {
      stat = await fs.stat(source);
    } catch {
      throw new ToolError(`Source not found: ${source}`);
    }

    const destExists = await fileExists(destination);
    if (destExists && !overwrite) {
      throw new ToolError(
        `Destination already exists: ${destination}`,
        "Pass overwrite=true to replace it, or choose a different destination.",
      );
    }

    const sourceRel = path.relative(ctx.cwd, source) || source;
    const destRel = path.relative(ctx.cwd, destination) || destination;

    const approved = await ctx.approve({
      tool: "copy",
      kind: "copy",
      title: `Copy ${sourceRel} → ${destRel}${stat.isDirectory() ? " (directory)" : ""}`,
      detail: stat.isDirectory()
        ? `Copy directory ${sourceRel} recursively to ${destRel}`
        : `Copy file ${sourceRel} (${stat.size} bytes) to ${destRel}`,
    });
    if (!approved) {
      throw new ToolError("User denied permission to copy this path. Do not retry without asking.");
    }

    if (stat.isDirectory()) {
      await fs.cp(source, destination, { recursive: true, force: overwrite });
    } else {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.copyFile(source, destination);
    }

    const copiedStat = await fs.stat(destination);
    return `Copied ${sourceRel} → ${destRel} (${formatBytes(copiedStat.size)})`;
  },
};
