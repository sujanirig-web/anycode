import type { Tool, ToolContext } from "./types.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { bashTool } from "./bash.js";
import { globTool } from "./glob.js";
import { grepTool } from "./grep.js";
import { listTool } from "./list.js";
import { deleteTool } from "./delete.js";
import { copyTool } from "./copy.js";
import { moveTool } from "./move.js";
import { mkdirTool } from "./mkdir.js";

export const builtinTools: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  listTool,
  deleteTool,
  copyTool,
  moveTool,
  mkdirTool,
];

export function findTool(name: string, tools: Tool[] = builtinTools): Tool | undefined {
  return tools.find((tool) => tool.name === name);
}

export type { Tool, ToolContext } from "./types.js";
export type { PermissionRequest } from "./types.js";
