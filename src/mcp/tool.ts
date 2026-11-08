import { errorMessage, ToolError } from "../errors.js";
import type { JsonSchema } from "../types.js";
import { limitOutput } from "../tools/util.js";
import type { Tool } from "../tools/types.js";
import type { McpCallResult, McpClient, McpToolDefinition } from "./client.js";

/** Provider-safe tool names: `mcp__<server>__<tool>`. */
export function mcpToolName(server: string, tool: string): string {
  return `mcp__${sanitizeSegment(server)}__${sanitizeSegment(tool)}`;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "_").replace(/_+/g, "_");
  return cleaned.replace(/^_+|_+$/g, "").slice(0, 48) || "tool";
}

function normalizeParameters(schema: unknown): JsonSchema {
  if (schema === null || typeof schema !== "object" || Array.isArray(schema)) {
    return { type: "object", properties: {} };
  }
  const parameters: JsonSchema = { ...(schema as Record<string, unknown>) };
  if (parameters.type !== "object") parameters.type = "object";
  if (
    parameters.properties === null ||
    typeof parameters.properties !== "object" ||
    Array.isArray(parameters.properties)
  ) {
    parameters.properties = {};
  }
  return parameters;
}

function summarizeInput(input: Record<string, unknown>): string | undefined {
  const keys = Object.keys(input);
  if (keys.length === 0) return undefined;
  let text: string;
  try {
    text = JSON.stringify(input);
  } catch {
    text = String(input);
  }
  return text.length > 800 ? `${text.slice(0, 797)}…` : text;
}

/** Convert an MCP tool definition into an anycode tool. */
export function createMcpTool(
  client: McpClient,
  server: string,
  definition: McpToolDefinition,
): Tool {
  const serverTool = definition.name;
  const readOnly = definition.annotations?.readOnlyHint === true;
  const name = mcpToolName(server, serverTool);
  const description = definition.description?.trim();

  return {
    name,
    ...(readOnly ? { readOnly: true } : {}),
    description: [
      description && description.length > 0
        ? description
        : `Call the "${serverTool}" tool on the "${server}" MCP server.`,
      `(MCP server: ${server})`,
    ].join(" "),
    parameters: normalizeParameters(definition.inputSchema),

    async execute(input, ctx) {
      if (!readOnly) {
        const allowed = await ctx.approve({
          tool: name,
          kind: "mcp",
          title: `Run MCP tool "${server}/${serverTool}"`,
          ...(summarizeInput(input) ? { detail: summarizeInput(input) } : {}),
        });
        if (!allowed) {
          throw new ToolError(
            `The user denied MCP tool "${server}/${serverTool}".`,
            "Do not retry the same call; ask the user how to proceed.",
          );
        }
      }

      let result: McpCallResult;
      try {
        result = await client.callTool(
          serverTool,
          input,
          ctx.signal ? { signal: ctx.signal } : {},
        );
      } catch (error) {
        throw new ToolError(
          `MCP tool "${server}/${serverTool}" failed: ${errorMessage(error)}`,
          "Check that the MCP server is still running, or retry with simpler arguments.",
        );
      }

      const text = formatResult(result);
      if (result?.isError) {
        throw new ToolError(
          text.length > 0 ? text : `MCP tool "${server}/${serverTool}" reported an error.`,
        );
      }
      return limitOutput(text.length > 0 ? text : "(no output)", 120_000);
    },
  };
}

/** Flatten the MCP content array into readable text for the model. */
export function formatResult(result: McpCallResult | undefined): string {
  if (!result || typeof result !== "object") {
    return result === undefined ? "" : String(result);
  }

  const parts: string[] = [];
  for (const part of result.content ?? []) {
    if (!part || typeof part !== "object") {
      parts.push(String(part));
      continue;
    }
    if (part.type === "text" && typeof part.text === "string") {
      parts.push(part.text);
    } else if (part.type === "image") {
      const mime = part.mimeType ?? "image";
      const size = typeof part.data === "string" ? `, ${part.data.length} base64 chars` : "";
      parts.push(`[image ${mime}${size}]`);
    } else if (part.type === "resource") {
      const resource = part.resource;
      if (typeof resource?.text === "string") parts.push(resource.text);
      else if (typeof resource?.uri === "string") parts.push(`[resource ${resource.uri}]`);
      else parts.push("[resource]");
    } else {
      try {
        parts.push(JSON.stringify(part));
      } catch {
        parts.push("[unserializable content]");
      }
    }
  }

  if (parts.length === 0 && result.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(result.structuredContent, null, 2));
    } catch {
      parts.push(String(result.structuredContent));
    }
  }

  return parts.join("\n");
}
