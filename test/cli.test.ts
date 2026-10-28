/*
┌──────────────────────────────────────────────────────────────────┐
│ test/cli.test.ts — CLI end-to-end, one-shot, NDJSON, help/version │
└──────────────────────────────────────────────────────────────────┘
*/
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { describe, it } from "node:test";

import { cleanup, tempDir } from "./helpers.js";

const PROJECT_ROOT = path.resolve(import.meta.dirname, "..");
const CLI = path.join(PROJECT_ROOT, "src", "cli.ts");

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        NO_COLOR: "1",
        ...options.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

interface FakeServer {
  baseURL: string;
  requests: number;
  close: () => Promise<void>;
}

/**
 * Minimal OpenAI-compatible server: the first request asks for a file write,
 * every later request returns plain text.
 */
async function startFakeProvider(): Promise<FakeServer> {
  const state = { requests: 0 };

  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      state.requests++;
      response.writeHead(200, {
        "content-type": "text/event-stream",
        connection: "close",
      });

      if (state.requests === 1) {
        const call = {
          id: "call_write",
          type: "function",
          function: {
            name: "write",
            arguments: JSON.stringify({
              path: "hello.txt",
              content: "created by anycode\n",
            }),
          },
        };
        response.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: { tool_calls: [{ index: 0, ...call }] },
                finish_reason: null,
              },
            ],
          })}\n\n`,
        );
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: "tool_calls" }],
          })}\n\n`,
        );
      } else {
        response.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { content: "Wrote the file." }, finish_reason: "stop" }],
          })}\n\n`,
        );
      }

      response.write(
        `data: ${JSON.stringify({
          choices: [],
          usage: { prompt_tokens: 21, completion_tokens: 7 },
        })}\n\n`,
      );
      response.write("data: [DONE]\n\n");
      response.end();

      // Keep the captured request body reachable for debugging assertions.
      void body;
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

describe("cli", () => {
  it("prints help without touching the network", async () => {
    const result = await runCli(["--help"], { cwd: PROJECT_ROOT });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Usage:/);
    assert.match(result.stdout, /--json/);
  });

  it("runs a prompt end to end and streams NDJSON events", async () => {
    const root = await tempDir();
    const home = await tempDir("anycode-home-");
    const provider = await startFakeProvider();
    try {
      const result = await runCli(
        [
          "--cwd",
          root,
          "--json",
          "--yolo",
          "-p",
          "openai",
          "--base-url",
          provider.baseURL,
          "-m",
          "fake-model",
          "create hello.txt",
        ],
        { cwd: PROJECT_ROOT, env: { ANYCODE_HOME: home } },
      );

      assert.equal(result.code, 0, result.stderr);

      const events = result.stdout
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as { type: string; [key: string]: unknown });

      assert.ok(events.some((event) => event.type === "turn_start"));
      assert.equal(events.filter((event) => event.type === "done").length, 1);

      const toolStart = events.find((event) => event.type === "tool_start") as
        | { call: { name: string } }
        | undefined;
      assert.equal(toolStart?.call.name, "write");

      const toolEnd = events.find((event) => event.type === "tool_end") as
        | { isError: boolean; content: string }
        | undefined;
      assert.equal(toolEnd?.isError, false);
      assert.match(toolEnd?.content ?? "", /Wrote hello\.txt/);

      const text = events
        .filter((event) => event.type === "text")
        .map((event) => String(event.text))
        .join("");
      assert.equal(text.trim(), "Wrote the file.");

      const written = await fs.readFile(path.join(root, "hello.txt"), "utf8");
      assert.equal(written, "created by anycode\n");

      const sessions = await fs.readdir(path.join(root, ".anycode", "sessions"));
      assert.equal(sessions.length, 1);
    } finally {
      await provider.close();
      await cleanup(root);
      await cleanup(home);
    }
  });

  it("reports provider failures with a non-zero exit code", async () => {
    const root = await tempDir();
    const home = await tempDir("anycode-home-");
    const server = http.createServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid key" } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    try {
      const result = await runCli(
        [
          "--cwd",
          root,
          "--json",
          "--yolo",
          "-p",
          "openai",
          "--base-url",
          `http://127.0.0.1:${port}/v1`,
          "-m",
          "fake-model",
          "do something",
        ],
        { cwd: PROJECT_ROOT, env: { ANYCODE_HOME: home } },
      );

      assert.notEqual(result.code, 0);
      assert.match(result.stderr + result.stdout, /401/);
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
      await cleanup(root);
      await cleanup(home);
    }
  });
});
