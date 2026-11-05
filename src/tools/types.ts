import type { JsonSchema } from "../types.js";

export interface PermissionRequest {
  /** Tool name, used for the "always allow" decision. */
  tool: string;
  kind: "bash" | "write" | "edit" | "delete" | "copy" | "move" | "mkdir";
  title: string;
  detail?: string;
}

export type FileChangeKind = "create" | "update" | "delete" | "copy" | "move" | "mkdir";

/** A filesystem mutation reported by a tool while it runs. */
export interface FileChange {
  kind: FileChangeKind;
  /** Path relative to the working directory, for display. */
  path: string;
  /** Unified diff body (without file headers) for text-file changes. */
  diff?: string;
  added?: number;
  removed?: number;
  /** Source path for copy and move. */
  from?: string;
  /** Destination path for copy and move. */
  to?: string;
  /** True when the change targets a directory. */
  directory?: boolean;
}

export interface ToolContext {
  cwd: string;
  signal?: AbortSignal;
  approve(request: PermissionRequest): Promise<boolean>;
  /** Report a filesystem mutation so the UI can show it immediately. */
  onFileChange?(change: FileChange): void;
}

export interface Tool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Marks tools that never touch the filesystem or spawn processes. */
  readOnly?: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<string>;
}
