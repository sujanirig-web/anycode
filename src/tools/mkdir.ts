import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import type { Tool } from "./types.js";
import { fileExists } from "./read.js";
import { requireString, resolvePath } from "./util.js";

export const mkdirTool: Tool = {
  name: "mkdir",
  description: [
    "Create a directory (and any parent directories) if it does not already exist.",
    "Equivalent to `mkdir -p`.",
    "The user is asked to approve before the directory is created.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory path to create (absolute or relative to the working directory)." },
    },
    required: ["path"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));

    const exists = await fileExists(target);
    if (exists) {
      throw new ToolError(`Path already exists: ${target}`);
    }

    const relative = path.relative(ctx.cwd, target) || target;

    const approved = await ctx.approve({
      tool: "mkdir",
      kind: "mkdir",
      title: `Create directory ${relative}`,
      detail: `mkdir -p ${relative}`,
    });
    if (!approved) {
      throw new ToolError("User denied permission to create this directory. Do not retry without asking.");
    }

    await fs.mkdir(target, { recursive: true });

    return `Created directory ${relative}`;
  },
};
