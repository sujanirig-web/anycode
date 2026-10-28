import type { JsonSchema } from "../types.js";

export interface PermissionRequest {
  /** Tool name, used for the "always allow" decision. */
  tool: string;
  kind: "bash" | "write" | "edit";
  title: string;
  detail?: string;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  approve(request: PermissionRequest): Promise<boolean>;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Marks tools that never touch the filesystem or spawn processes. */
  readOnly?: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
