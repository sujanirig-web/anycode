/**
 * Public library surface. Import from "anycode" to embed the agent loop in
 * another program, or use the CLI for the terminal experience.
 */
export { Agent } from "./agent/agent.js";
export type { AgentEvent, AgentOptions } from "./agent/agent.js";
export { createSystemPrompt, buildSystemPrompt, loadProjectRules } from "./agent/prompt.js";
export { PermissionBroker, createPermissionGate } from "./agent/permissions.js";
export { Session, listSessions, latestSession } from "./agent/session.js";
export { loadConfig, saveGlobalConfig } from "./config.js";
export type { Config } from "./config.js";
export { createProvider, AnthropicProvider, OpenAIProvider, MockProvider } from "./llm/index.js";
export { builtinTools, findTool } from "./tools/index.js";
export type { Tool, ToolContext, PermissionRequest } from "./tools/index.js";
export type { Message, ToolCall, Usage, Provider } from "./types.js";
export { VERSION, NAME } from "./version.js";
