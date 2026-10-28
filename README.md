# anycode

A small, hackable terminal AI coding agent. It streams responses, reads and
edits files, runs shell commands, and persists sessions so you can pick up where
you left off. Providers are interchangeable: Anthropic, OpenAI, any
OpenAI-compatible endpoint, or a local Ollama server.

Written in plain TypeScript with **no runtime dependencies** — only Node.js
built-ins. The compiled output is a handful of ES modules.

```
› add a retry helper to src/http.ts and run the tests

⏺ read src/http.ts
  ⎿ src/http.ts (lines 1-84 of 84)
⏺ edit src/http.ts (+18 -0)
  ⎿ Updated src/http.ts (+18 -0, 1 replacement)
⏺ bash npm test
  ⎿ status: exit code 0 · 34 tests passed

Added `withRetry()` with exponential backoff and wired it into `getJson()`.
Tests pass.
```

## Features

- **Provider-agnostic** — Anthropic Messages API, OpenAI Chat Completions, any
  OpenAI-compatible gateway, or Ollama. Streaming everywhere, with retries on
  429/5xx.
- **Useful tools** — `read`, `write`, `edit`, `bash`, `glob`, `grep`, with
  path safety, binary detection, output truncation, and recovery hints.
- **Approval gates** — writes, edits, and shell commands ask first. Approve once,
  always for the session, or disable prompts with `--yolo`.
- **Sessions** — every turn is saved to `.anycode/sessions/<id>.json`. Resume
  with `--continue`, `--session <id>`, or `anycode resume`.
- **Interactive REPL and one-shot mode** — slash commands (`/model`, `/provider`,
  `/resume`, `/usage`, `/yolo`, …), Ctrl+C interruption, and piping.
- **NDJSON event stream** — `--json` emits every agent event as JSON lines for
  scripting, UIs, or tests.
- **Project rules** — `AGENTS.md`, `CLAUDE.md`, or `.anycode/AGENTS.md` are
  injected into the system prompt automatically.
- **Context trimming** — long histories are compacted at user-turn boundaries so
  tool calls and results stay paired.
- **Library surface** — import `Agent`, tools, providers, and session storage to
  embed the loop in another program.

## Requirements

- Node.js **20 or newer** (Node 24 recommended)
- An API key for a hosted provider, or a local model server

## Install

```bash
git clone https://github.com/sujanirig-web/anycode.git
cd anycode
npm install
npm run build
npm link          # optional: puts `anycode` on your PATH
```

Or run it without building:

```bash
npm run dev -- "explain this repository"
```

## Quick start

```bash
export ANTHROPIC_API_KEY=sk-ant-...

anycode                              # interactive REPL
anycode "add a health check endpoint" # one task, then exit
anycode run "fix the failing test"    # explicit form
```

OpenAI:

```bash
export OPENAI_API_KEY=sk-...
anycode -p openai -m gpt-4.1 "review src/agent.ts"
```

OpenAI-compatible gateway or a local server:

```bash
anycode -p openai-compatible \
  --base-url http://localhost:8080/v1 \
  -m my-model \
  "write a README"
```

Ollama (no key needed):

```bash
ollama pull qwen2.5-coder
anycode -p ollama -m qwen2.5-coder "fix the type errors"
```

## CLI

```
anycode                     Start the interactive REPL
anycode "<task>"            Run one task and exit
anycode run "<task>"        Same, explicit form
anycode resume [id]         Resume a session (default: most recent)
anycode sessions            List saved sessions for this directory
anycode config              Show the effective configuration
```

Options:

| Flag | Description |
| --- | --- |
| `-m, --model <name>` | Model to use |
| `-p, --provider <id>` | `anthropic`, `openai`, `openai-compatible`, `ollama` |
| `--base-url <url>` | Override the provider base URL |
| `--api-key <key>` | Override the API key (prefer environment variables) |
| `-s, --session <id>` | Resume a specific session |
| `-c, --continue` | Continue the most recent session |
| `-y, --yolo` | Auto-approve write, edit, and bash |
| `--json` | Stream events as newline-delimited JSON |
| `--cwd <dir>` | Run against another working directory |
| `--max-steps <n>` | Maximum agent steps per turn (default 50) |
| `--max-tokens <n>` | Maximum output tokens per model call |
| `--no-color` | Disable ANSI colors |
| `-h, --help` / `-v, --version` | Help / version |

### JSON event stream

`--json` writes one JSON object per line to stdout. Exit codes: `0` success,
`1` unrecoverable error, `130` interrupted.

```json
{"type":"turn_start","step":1}
{"type":"tool_start","call":{"id":"call_1","name":"write","arguments":"{\"path\":\"a.txt\",\"content\":\"hi\"}"},"input":{"path":"a.txt","content":"hi"}}
{"type":"tool_end","call":{"id":"call_1","name":"write","arguments":"..."},"content":"Wrote a.txt (2 B, 1 lines)","isError":false,"durationMs":3}
{"type":"text","text":"Done."}
{"type":"usage","usage":{"inputTokens":120,"outputTokens":8,"cacheReadTokens":0,"cacheWriteTokens":0}}
{"type":"done","steps":1,"usage":{"...":"..."},"aborted":false}
```

### REPL commands

```
/help              Show help
/new               Start a new session (alias: /clear)
/model [name]      Show or change the model
/provider [id]     Show or change the provider (optionally with a model)
/sessions          List saved sessions
/resume [id]       Resume a session (default: most recent)
/yolo              Toggle auto-approve for the rest of the session
/usage             Show token usage
/tools             List available tools
/exit              Quit (alias: /quit)
```

`\` at the end of a line continues the prompt. Ctrl+C interrupts a running turn;
press it twice at the prompt to exit.

## Tools and permissions

| Tool | Read-only | What it does |
| --- | --- | --- |
| `read` | yes | Read a text file with line numbers, paged via `offset`/`limit` |
| `glob` | yes | Find files by glob, newest first |
| `grep` | yes | Regex search with ripgrep when available, built-in fallback |
| `write` | no | Create or replace a file, with a diff preview |
| `edit` | no | Exact-string replacement, fails on missing/ambiguous matches |
| `bash` | no | Run a shell command with a timeout and exit code |

- Tools that mutate state require approval. Answer `y`, `n`, or `a` (always for
  this session). `--yolo` skips prompts entirely.
- In non-interactive runs (piped stdin, `--json`), mutations are **denied**
  unless `--yolo` is passed. This makes CI use explicit.
- `bash` uses the platform shell (`cmd.exe` on Windows, `$SHELL` elsewhere).
  Commands are killed on timeout or abort.
- Paths resolve against the working directory. `~/` is expanded.

## Configuration

Precedence, highest first:

1. CLI flags
2. Environment variables (`ANYCODE_PROVIDER`, `ANYCODE_MODEL`,
   `ANYCODE_BASE_URL`, `ANYCODE_API_KEY`)
3. Provider-specific key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`)
4. `<cwd>/.anycode/config.json`
5. `~/.anycode/config.json`
6. Built-in defaults

Example `.anycode/config.json`:

```json
{
  "provider": "openai",
  "model": "gpt-4.1",
  "maxTokens": 8192,
  "maxSteps": 50,
  "contextTokens": 200000,
  "temperature": 0.2,
  "autoApprove": false
}
```

Set `ANYCODE_HOME` to relocate the global config directory (useful for tests
and sandboxes). `anycode config` prints the effective values with the API key
masked.

### Project rules

At startup anycode reads, in order, the first of `AGENTS.md`, `CLAUDE.md`, or
`.anycode/AGENTS.md` in the working directory, plus `~/.anycode/AGENTS.md`, and
adds them to the system prompt. Use this for build commands, style rules, and
things the agent should never touch.

## Sessions

Sessions live in `<cwd>/.anycode/sessions/<id>.json` and contain the full
message history plus token usage. They are written after every tool step.

```bash
anycode sessions
anycode resume            # most recent
anycode resume 20261028-141500-a1b2 "now add tests"
anycode -c "keep going"
```

## Library usage

```ts
import { Agent, Session, createProvider, createSystemPrompt, builtinTools } from "anycode";

const cwd = process.cwd();
const session = Session.create({ cwd, provider: "anthropic", model: "claude-sonnet-4-5" });
const provider = createProvider({
  id: "anthropic",
  model: session.model,
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const agent = new Agent({
  provider,
  model: session.model,
  cwd,
  session,
  system: await createSystemPrompt(cwd, "anthropic", session.model),
  tools: builtinTools,
  approve: async () => true, // or wire up your own UI
});

for await (const event of agent.run("summarize this project")) {
  if (event.type === "text") process.stdout.write(event.text);
}
```

`Agent.run()` yields normalized events: `turn_start`, `text`, `reasoning`,
`tool_start`, `tool_end`, `usage`, `compaction`, `notice`, `error`, `done`.
Providers only need to implement `Provider.stream(request)` and yield
`ProviderEvent`s.

## Architecture

```
src/
  cli.ts              executable bootstrap (sets NO_COLOR before imports)
  main.ts             CLI parsing, one-shot/JSON modes, REPL wiring
  config.ts           layered config loading
  types.ts            messages, usage, provider contracts
  errors.ts           UserError, ToolError, ProviderError, abort detection
  agent/
    agent.ts          streaming tool loop, compaction, persistence
    prompt.ts         system prompt + project rules
    session.ts        session create/load/save/list
    permissions.ts    approval broker
  llm/
    http.ts           streaming POST with retries
    anthropic.ts      Anthropic Messages provider
    openai.ts         OpenAI Chat Completions provider
    mock.ts           deterministic provider for tests
  tools/              read, write, edit, bash, glob, grep
  ui/                 renderer, REPL, approval prompt
  util/               ANSI, diff, glob, SSE, spinner, text
test/                 unit, provider, agent, and CLI end-to-end tests
```

The loop is deliberately small: send history → stream text/tool calls → execute
tools → append results → repeat until the model stops, the step limit is hit, or
the user aborts. Every provider is converted into the same event stream, so the
agent never branches on vendor.

### Adding a tool

Implement the `Tool` interface in `src/tools/`, then register it in
`src/tools/index.ts`:

```ts
export const helloTool: Tool = {
  name: "hello",
  readOnly: true,
  description: "Return a greeting.",
  parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
  async execute(input) {
    return `Hello, ${String(input.name)}!`;
  },
};
```

Throw `ToolError(message, hint)` for recoverable failures; the message and hint
are fed back to the model so it can adjust.

### Adding a provider

Implement `Provider` in `src/llm/`, translate the wire format into
`ProviderEvent`s, and add a case in `createProvider`. Use `parseSSE` and
`postStream` to get incremental parsing and retries for free.

## Development

```bash
npm run typecheck     # tsc --noEmit over src + test
npm test              # unit, provider, agent, CLI E2E (fake server)
npm run build         # emit dist/
npm run dev -- "..."  # run from source with tsx
```

The test suite starts real local HTTP servers to exercise both providers, and
spawns the CLI against a fake OpenAI-compatible endpoint. No network or API keys
are required.

## Limitations

- Single agent, no subagents or MCP yet.
- Text-only: no image or PDF input.
- Context compaction drops the oldest user turns; it does not summarize.
- `bash` is a full shell with the user's permissions. Approval prompts and
  `--yolo` are the guardrail — run it in a container if that is not enough.
- Token counts are provider-reported; compaction estimates are approximate.

## License

MIT
