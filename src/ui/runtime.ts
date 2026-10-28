import type { Agent } from "../agent/agent.js";
import type { PermissionBroker } from "../agent/permissions.js";
import type { Session, SessionMeta } from "../agent/session.js";

export interface RebuildChanges {
  session?: Session;
  providerId?: string;
  model?: string;
}

export interface RebuildResult {
  agent: Agent;
  session: Session;
  providerId: string;
  model: string;
}

/** Mutable chat state shared by the REPL, the full-screen TUI and commands. */
export interface ChatState {
  session: Session;
  agent: Agent;
  providerId: string;
  model: string;
}

export interface ChatRuntime {
  cwd: string;
  rebuild(changes: RebuildChanges): Promise<RebuildResult>;
  listSessions(): Promise<SessionMeta[]>;
  loadSession(id: string): Promise<Session>;
  /** List available providers including custom presets. */
  listProviders(): Promise<Array<{ id: string; model: string; baseURL?: string; keyEnv?: string; contextTokens?: number; site?: string }>>;
  /** Save a custom provider preset to the global config. */
  saveProvider(id: string, preset: { model?: string; baseURL?: string; keyEnv?: string; contextTokens?: number; site?: string }): Promise<void>;
}

/** Everything an interactive front end (REPL or TUI) needs, built by `main.ts`. */
export interface InteractiveRuntime extends ChatRuntime {
  session: Session;
  agent: Agent;
  providerId: string;
  model: string;
  broker: PermissionBroker;
}
