import type { PermissionRequest } from "../tools/types.js";

export type PermissionAnswer = "yes" | "no" | "always";
export type AskPermission = (request: PermissionRequest) => Promise<PermissionAnswer>;

export interface PermissionState {
  autoApprove: boolean;
  /** Tool names the user approved for the rest of the session. */
  allowed: Set<string>;
  ask: AskPermission;
}

/**
 * Creates the approval function handed to tools. "Always" is remembered per
 * tool for this session only; nothing is persisted, so a new run asks again.
 */
export function createPermissionGate(
  state: PermissionState,
): (request: PermissionRequest) => Promise<boolean> {
  return async (request) => {
    if (state.autoApprove) return true;
    if (state.allowed.has(request.tool)) return true;

    const answer = await state.ask(request);
    if (answer === "always") {
      state.allowed.add(request.tool);
      return true;
    }
    return answer === "yes";
  };
}

/** Mutable approval state that survives agent rebuilds inside one REPL. */
export class PermissionBroker {
  readonly allowed = new Set<string>();
  handler: AskPermission = async () => "no";

  constructor(public autoApprove = false) {}

  async approve(request: PermissionRequest): Promise<boolean> {
    if (this.autoApprove || this.allowed.has(request.tool)) return true;
    const answer = await this.handler(request);
    if (answer === "always") {
      this.allowed.add(request.tool);
      return true;
    }
    return answer === "yes";
  }
}

/** Non-interactive gate: denies everything unless autoApprove is set. */
export function nonInteractiveGate(autoApprove: boolean, allowed = new Set<string>()) {
  return createPermissionGate({
    autoApprove,
    allowed,
    ask: async () => "no",
  });
}
