import { promises as fs } from "node:fs";
import path from "node:path";
import { ToolError } from "../errors.js";
import { diffLines } from "../util/diff.js";
import { formatBytes } from "../util/text.js";
import { fileExists } from "./read.js";
import type { Tool } from "./types.js";
import {
  displayPath,
  limitOutput,
  requireString,
  resolvePath,
} from "./util.js";

export const writeTool: Tool = {
  name: "write",
  description: [
    "Create a new file or completely replace an existing file.",
    "Parent directories are created automatically.",
    "Prefer edit for small changes so existing content is preserved; use write for new files or full rewrites.",
    "The user is asked to approve the change, with a diff preview when the file already exists.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to the working directory)." },
      content: { type: "string", description: "Full file content to write (UTF-8)." },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));
    const content = requireString(input, "content", { allowEmpty: true });
    const exists = await fileExists(target);

    let preview: string;
    let summary = "";
    if (exists) {
      const before = await fs.readFile(target, "utf8");
      const diff = diffLines(before, content);
      preview = diff.text || "(content unchanged)";
      summary = ` (+${diff.added} -${diff.removed})`;
    } else {
      const lines = content.length === 0 ? 0 : content.split("\n").length;
      preview = `new file${lines > 0 ? ` (${lines} lines, ${formatBytes(Buffer.byteLength(content))})` : " (empty)"}`;
    }

    const relative = displayPath(ctx.cwd, target);
    const approved = await ctx.approve({
      tool: "write",
      kind: "write",
      title: `Write ${relative}${summary}`,
      detail: limitOutput(preview, 12_000),
    });
    if (!approved) {
      throw new ToolError("User denied permission to write this file. Do not retry without asking.");
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, "utf8");

    const lines = content.length === 0 ? 0 : content.split("\n").length;
    return `Wrote ${relative} (${formatBytes(Buffer.byteLength(content))}, ${lines} lines)${summary}`;
  },
};
