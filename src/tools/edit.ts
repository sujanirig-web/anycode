import { promises as fs } from "node:fs";
import { ToolError } from "../errors.js";
import { diffLines } from "../util/diff.js";
import type { Tool } from "./types.js";
import {
  countOccurrences,
  displayPath,
  limitOutput,
  optionalBoolean,
  readTextFile,
  requireString,
  resolvePath,
} from "./util.js";

export const editTool: Tool = {
  name: "edit",
  description: [
    "Replace an exact string in a file. The edit fails when old_string is missing or ambiguous.",
    "Read the file first and copy the target text exactly, including indentation.",
    'Set replace_all to true only when every occurrence should change.',
    "The user is asked to approve the change, with a diff preview.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path (absolute or relative to the working directory)." },
      old_string: { type: "string", description: "Exact text to replace." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match. Defaults to false." },
    },
    required: ["path", "old_string", "new_string"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const target = resolvePath(ctx.cwd, requireString(input, "path"));
    const oldString = requireString(input, "old_string");
    const newString = requireString(input, "new_string", { allowEmpty: true });
    const replaceAll = optionalBoolean(input, "replace_all") ?? false;

    if (oldString === newString) {
      throw new ToolError("old_string and new_string are identical; nothing to do.");
    }

    const before = await readTextFile(target);
    const occurrences = countOccurrences(before, oldString);

    if (occurrences === 0) {
      throw new ToolError(
        `old_string was not found in ${displayPath(ctx.cwd, target)}.`,
        "Read the file and copy the exact text (including whitespace). Do not guess.",
      );
    }
    if (occurrences > 1 && !replaceAll) {
      throw new ToolError(
        `old_string appears ${occurrences} times in ${displayPath(ctx.cwd, target)}, so the edit is ambiguous.`,
        "Include more surrounding context to make it unique, or pass replace_all=true.",
      );
    }

    const after = replaceAll
      ? before.split(oldString).join(newString)
      : before.replace(oldString, newString);

    const diff = diffLines(before, after);
    const relative = displayPath(ctx.cwd, target);
    const approved = await ctx.approve({
      tool: "edit",
      kind: "edit",
      title: `Edit ${relative} (+${diff.added} -${diff.removed})`,
      detail: limitOutput(diff.text, 12_000),
    });
    if (!approved) {
      throw new ToolError("User denied permission to edit this file. Do not retry without asking.");
    }

    await fs.writeFile(target, after, "utf8");
    return `Updated ${relative} (+${diff.added} -${diff.removed}, ${occurrences} ${
      occurrences === 1 ? "replacement" : "replacements"
    })`;
  },
};
