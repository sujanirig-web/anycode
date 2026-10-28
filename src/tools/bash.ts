import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { ToolError } from "../errors.js";
import { clamp } from "../util/text.js";
import type { Tool } from "./types.js";
import { limitOutput, optionalNumber, optionalString, requireString } from "./util.js";

const MAX_OUTPUT = 200_000;

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true,
    });
  }
  child.kill("SIGKILL");
}

function runShell(
  command: string,
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;

    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      env: process.env,
    });

    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= MAX_OUTPUT) return current;
      return current + chunk.toString("utf8").slice(0, MAX_OUTPUT - current.length);
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = append(stderr, chunk);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const finish = (exitCode: number | null, exitSignal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);

      const status = aborted
        ? "aborted"
        : timedOut
          ? `timed out after ${timeoutMs}ms`
          : exitCode !== null
            ? `exit code ${exitCode}`
            : `killed (${exitSignal ?? "unknown signal"})`;

      const sections = [`$ ${command}`, `status: ${status}`];
      const out = stdout.replace(/\s+$/, "");
      const err = stderr.replace(/\s+$/, "");
      if (out) sections.push("--- stdout ---", out);
      if (err) sections.push("--- stderr ---", err);
      if (!out && !err) sections.push("(no output)");

      resolve(limitOutput(sections.join("\n"), 30_000));
    };

    child.on("error", (error) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(`$ ${command}\nstatus: failed to start\n${error.message}`);
    });

    child.on("close", finish);
  });
}

export const bashTool: Tool = {
  name: "bash",
  description: [
    "Execute a shell command in the working directory and return stdout, stderr and the exit code.",
    "Use it for builds, tests, git, package managers and other terminal operations.",
    "Prefer read/write/edit/glob/grep for file work instead of cat/sed/find.",
    "Commands are killed after the timeout (default 120000 ms, max 600000 ms).",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute." },
      description: { type: "string", description: 'Short human-readable description, e.g. "Run unit tests".' },
      timeout: { type: "number", description: "Timeout in milliseconds (default 120000, max 600000)." },
    },
    required: ["command"],
    additionalProperties: false,
  },

  async execute(input, ctx) {
    const command = requireString(input, "command");
    const description = optionalString(input, "description");
    const timeout = clamp(Math.trunc(optionalNumber(input, "timeout") ?? 120_000), 1_000, 600_000);

    if (ctx.signal?.aborted) throw new ToolError("Command aborted before it started.");

    const approved = await ctx.approve({
      tool: "bash",
      kind: "bash",
      title: description ? `Run: ${description}` : "Run command",
      detail: command,
    });
    if (!approved) {
      throw new ToolError("User denied permission to run this command. Do not retry without asking.");
    }

    return runShell(command, ctx.cwd, timeout, ctx.signal);
  },
};
