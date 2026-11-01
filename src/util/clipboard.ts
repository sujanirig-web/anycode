import { spawn } from "node:child_process";
import { platform } from "node:process";

interface ClipboardCommand {
  command: string;
  args: string[];
}

const MAX_CLIPBOARD_BYTES = 1_000_000;

function commandsFor(action: "read" | "write"): ClipboardCommand[] {
  if (platform === "darwin") {
    return [{ command: action === "read" ? "pbpaste" : "pbcopy", args: [] }];
  }
  if (platform === "win32") {
    return action === "read"
      ? [{ command: "powershell.exe", args: ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-Clipboard -Raw"] }]
      : [{ command: "clip.exe", args: [] }];
  }
  return action === "read"
    ? [
        { command: "wl-paste", args: ["--no-newline"] },
        { command: "xclip", args: ["-selection", "clipboard", "-o"] },
        { command: "xsel", args: ["--clipboard", "--output"] },
      ]
    : [
        { command: "wl-copy", args: [] },
        { command: "xclip", args: ["-selection", "clipboard"] },
        { command: "xsel", args: ["--clipboard", "--input"] },
      ];
}

function runClipboardCommand(spec: ClipboardCommand, inputText?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;

    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_CLIPBOARD_BYTES) {
        child.kill();
        if (!settled) {
          settled = true;
          reject(new Error("Clipboard contents exceed 1 MB."));
        }
        return;
      }
      chunks.push(chunk);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${spec.command} exited with status ${code ?? "unknown"}.`));
    });

    if (inputText === undefined) {
      child.stdin.end();
    } else {
      child.stdin.end(inputText);
    }
  });
}

export async function readClipboard(): Promise<string> {
  let lastError: unknown;
  for (const command of commandsFor("read")) {
    try {
      return await runClipboardCommand(command);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No supported clipboard reader is available.");
}

export async function writeClipboard(text: string): Promise<void> {
  let lastError: unknown;
  for (const command of commandsFor("write")) {
    try {
      await runClipboardCommand(command, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("No supported clipboard writer is available.");
}