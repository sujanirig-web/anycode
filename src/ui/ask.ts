import type { Interface } from "node:readline/promises";
import type { AskPermission } from "../agent/permissions.js";
import { color } from "../util/ansi.js";
import type { Spinner } from "../util/spinner.js";
import type { Renderer } from "./renderer.js";

export interface AskOptions {
  rl: Interface;
  renderer: Renderer;
  spinner: Spinner;
  signal?: AbortSignal;
}

/** Interactive yes/no/always prompt used for write, edit and bash approvals. */
export function createAskPermission(options: AskOptions): AskPermission {
  const { rl, renderer, spinner, signal } = options;

  return async (request) => {
    spinner.stop();
    renderer.permission(request);

    for (;;) {
      let answer: string;
      try {
        answer = (
          await rl.question(color.yellow("  allow? [y]es [n]o [a]lways › "), {
            ...(signal ? { signal } : {}),
          })
        )
          .trim()
          .toLowerCase();
      } catch {
        return "no";
      }

      if (answer === "" || answer.startsWith("n")) return "no";
      if (answer.startsWith("y")) return "yes";
      if (answer.startsWith("a")) return "always";
      renderer.info("Please answer y, n or a.");
    }
  };
}
