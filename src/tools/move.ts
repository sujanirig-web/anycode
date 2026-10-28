import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import type { Tool } from "./types.js";
import { fileExists } from "./read.js";
import { optionalBoolean, requireString, resolvePath } from "./util.js";
import { formatBytes } from "../util/text.js";

export const moveTool: Tool = {
  name: "move",
  description: [
    "Move (rename) a file or directory to a new location.",
    "Parent directories of the destination are created automatically.",
    "The user is asked to approve before anything is moved.",
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
      tool: "move",
      kind: "move",
      title: `Move ${sourceRel} → ${destRel}${stat.isDirectory() ? " (directory)" : ""}`,
      detail: stat.isDirectory()
        ? `Move directory ${sourceRel} to ${destRel}`
        : `Move file ${sourceRel} (${stat.size} bytes) to ${destRel}`,
    });
    if (!approved) {
      throw new ToolError("User denied permission to move this path. Do not retry without asking.");
    }

    if (destExists && overwrite) {
      await fs.rm(destination, { recursive: true, force: true });
    }

    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);

    const movedStat = await fs.stat(destination);
    return `Moved ${sourceRel} → ${destRel} (${formatBytes(movedStat.size)})`;
  },
};
