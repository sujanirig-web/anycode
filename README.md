# anycode

A small, hackable terminal AI coding agent with a full-screen TUI. It streams
responses, reads and edits files, runs shell commands, and persists sessions so
you can pick up where you left off. Providers are interchangeable: Anthropic,
OpenAI, any OpenAI-compatible endpoint, a local Ollama server, or a local
[AnyRoute](https://github.com/sujanirig-web/anycode) gateway.

Written in plain TypeScript with **no runtime dependencies** — only Node.js
built-ins. The compiled output is a handful of ES modules, and the TUI is built
directly on raw terminal input and the alternate screen buffer.

```
anycode v0.2.0 ───────────────────────────────── anyroute/anyroute

  › add a retry helper to src/http.ts and run the tests

  ┌─ ▾ add a retry helper to src/http.ts · 2 steps · 1 file ──────────┐
  │                                                                  │
  │ ├─ ✓ read  src/http.ts                                   (0.1s)  │
  │ └─ ⋯ edit  src/http.ts                                          │
  │                                                                  │
  │ ✎ update src/http.ts (+18 -0)                                    │
  │     @@ -1,0 +1,18 @@                                              │
  │     +export async function withRetry() {                          │
  │     +  // ...                                                     │
  └──────────────────────────────────────────────────────────────────┘

  ⏺ bash npm test
    ⎿ status: exit code 0 · 34 tests passed

  Added `withRetry()` with exponential backoff and wired it into `getJson()`.
  Tests pass.

 ⠹ thinking · 1.2s                     12,480 in · 312 out
 ┌───────────────────────────────────────────────────────────────┐
 │ › █                                                           │
 └───────────────────────────────────────────────────────────────┘
 enter send · ctrl+j newline · /help · esc or ctrl+d quit · ctrl+o details
```

## Features

- **Full-screen TUI** — alternate screen buffer, scrollable transcript, inline
  markdown/code rendering, a multi-line composer with history, live token/status
  line, tool approvals as in-frame prompts, and a diff-based painter. Falls back
  to a line REPL with `--no-tui` or when stdout is not a TTY.
- **Provider-agnostic** — Anthropic Messages API, OpenAI Chat Completions, any
  OpenAI-compatible gateway, Ollama, or a local AnyRoute gateway. Streaming
  everywhere, with retries on 429/5xx.
- **Useful tools** — `read`, `write`, `edit`, `bash`, `glob`, `grep`,
  `websearch`, with path safety, binary detection, output truncation, and
  recovery hints.
- **Live coding box** — each request opens a bordered activity box titled with
  what you asked for. Tool steps, timings, status, and colored file diffs update
  inside it in realtime. When the turn finishes the box collapses to a compact
  change list; `ctrl+o` reveals the full diffs, and the status strip keeps a
  changed-file count.
- **Approval gates** — writes, edits, and shell commands ask first. Approve once,
  always for the session, or disable prompts with `--yolo`.
- **Sessions** — every turn is saved to `.anycode/sessions/<id>.json`. Resume
  with `--continue`, `--session <id>`, or `anycode resume`. In the TUI, click the
  `<` in the top-left to browse saved sessions, start a `+ New session`, or
  delete one.
- **Interactive and one-shot modes** — slash commands (`/models`, `/connect`,
  `/resume`, `/usage`, `/yolo`, …), Ctrl+C interruption, and piping.
- **NDJSON event stream** — `--json` emits every agent event as JSON lines for
  scripting, UIs, or tests.
- **Project rules** — `AGENTS.md`, `CLAUDE.md`, or `.anycode/AGENTS.md` are
  injected into the system prompt automatically.
- **Context trimming** — long histories are compacted at user-turn boundaries so
  tool calls and results stay paired.
- **MCP servers** — connect stdio [Model Context Protocol](https://modelcontextprotocol.io)
  servers from `mcp.json`; their tools appear to the model as `mcp__<server>__<tool>`.
- **Plugins** — drop ESM files into `.anycode/plugins/` to add tools, slash
  commands, and turn/tool hooks.
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

anycode                              # full-screen TUI
anycode --no-tui                     # plain line REPL
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

AnyRoute (local gateway, no key needed):

```bash
anyroute serve                       # starts http://127.0.0.1:3456
anycode -p anyroute -m anyroute "fix the type errors"

# Pick a routed upstream model explicitly:
anycode -p anyroute -m gemini/gemini-flash-lite-latest "review src/agent.ts"
```

AnyRoute is OpenAI-compatible, so it can also be used through
`-p openai-compatible --base-url http://127.0.0.1:3456/v1`. Model ids depend on
the gateway configuration (`anyroute`, `auto`, `free`, `gemini`, or a specific
`gemini/...` id). Set `ANYROUTE_API_KEY` only if the gateway requires auth.

To make AnyRoute the default provider, put this in `~/.anycode/config.json`:

```json
{ "provider": "anyroute", "model": "anyroute" }
```

### Providers

Choose a hosted or local provider from the TUI:

```text
anycode
/connect
```

Connect includes Anthropic, OpenAI, NVIDIA NIM, Mistral, Gemini, DeepSeek,
Groq, OpenRouter, Together, Fireworks, Cerebras, xAI, Cohere, SambaNova,
Perplexity, Ollama, AnyRoute, and saved custom endpoints. The list is curated,
not an exhaustive catalog of every AI service; use the custom provider form for
other OpenAI-compatible APIs.

When connecting to AnyRoute, Connect asks for the gateway base URL so you can
override the default `http://127.0.0.1:3456/v1` endpoint for a remote or custom
gateway. This endpoint override is kept in memory for the current process.

The API key is entered in a masked prompt and kept in memory for the current
process. It is not written to the project or global config. Existing environment
variables and config keys can also be used by leaving the key prompt empty.

Use the Models tab to browse the selected provider's model catalog or enter a
model ID manually. Model catalog availability depends on the provider API.

Add a custom OpenAI-compatible endpoint from Connect; its provider ID, model,
and base URL are saved to `~/.anycode/config.json` (the API key is not):

```text
my-llm custom-model https://api.example.com/v1 MY_LLM_KEY
```

Custom providers are merged with built-in defaults, so you can override any built-in
provider's model, base URL, or context window by adding a preset with the same ID.

## CLI

```
anycode                     Start the interactive TUI
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
| `-p, --provider <id>` | Built-in provider ID or saved custom provider ID; use `/connect` to browse |
| `--base-url <url>` | Override the provider base URL |
| `--api-key <key>` | Override the API key (prefer environment variables) |
| `-s, --session <id>` | Resume a specific session |
| `-c, --continue` | Continue the most recent session |
| `-y, --yolo` | Auto-approve write, edit, and bash |
| `--json` | Stream events as newline-delimited JSON |
| `--cwd <dir>` | Run against another working directory |
| `--no-tui` | Use the plain line REPL instead of the full-screen UI |
| `--max-steps <n>` | Maximum agent steps per turn (default 50) |
| `--max-tokens <n>` | Maximum output tokens per model call |
| `--no-color` | Disable ANSI colors |
| `-h, --help` / `-v, --version` | Help / version |

Set `ANYCODE_NO_TUI=1` to force the line REPL without a flag. The TUI is used
automatically when both stdin and stdout are TTYs and a prompt argument is not
given.

### JSON event stream

`--json` writes one JSON object per line to stdout. Exit codes: `0` success,
`1` unrecoverable error, `130` interrupted.

```json
{"type":"turn_start","step":1}
{"type":"tool_start","call":{"id":"call_1","name":"write","arguments":"{\"path\":\"a.txt\",\"content\":\"hi\"}"},"input":{"path":"a.txt","content":"hi"}}
{"type":"tool_end","call":{"id":"call_1","name":"write","arguments":"..."},"content":"Wrote a.txt (2 B, 1 lines)","isError":false,"durationMs":3}
{"type":"file_change","change":{"kind":"create","path":"a.txt","diff":"@@ -0,0 +1,1 @@\n+hi","added":1,"removed":0}}
{"type":"text","text":"Done."}
{"type":"usage","usage":{"inputTokens":120,"outputTokens":8,"cacheReadTokens":0,"cacheWriteTokens":0}}
{"type":"done","steps":1,"usage":{"...":"..."},"aborted":false}
```

### Interactive UI

The full-screen TUI opens on a terminal when no prompt is given. It keeps the
transcript in the scrollback region, streams assistant text and tool output live,
and shows the composer, status line and footer at the bottom.

Keys:

| Key | Action |
| --- | --- |
| `enter` | Send the prompt |
| `ctrl+j` (or `alt+enter`, `ctrl+enter`) | Insert a newline |
| `esc` | Clear the composer |
| `↑` / `↓` | Move between lines, or recall prompt history |
| `ctrl+a` / `ctrl+e` | Start / end of line |
| `ctrl+←` / `ctrl+→` | Move by word |
| `ctrl+k` / `ctrl+u` / `ctrl+w` | Kill to end / start / previous word |
| `ctrl+o` | Expand or collapse tool output |
| `alt+e` | Expand or collapse the latest activity card |
| `ctrl+t` | Toggle verbose mode: expand or collapse every activity card |
| `tab` while working / `ctrl+q` | Open the prompt queue; use `e` to edit or `x`/`delete` to remove a queued prompt |
| `pageup` / `pagedown` | Scroll the transcript |
| `ctrl+c` | Copy composer text when nonempty; with an empty composer, interrupt a turn |
| `ctrl+v` | Paste system clipboard text at the composer cursor |
| `ctrl+d` or `esc` (empty composer) | Quit |
| `ctrl+l` | Repaint the screen |
| `<` in the top-left (or `alt+s`) | Open the session picker |
| In the picker: `↑`/`↓`, `enter` | Move the selection and open the session |
| In the picker: `+ New session` | Start a fresh session |
| In the picker: `d` then `y` | Delete the highlighted session (Esc cancels) |

While a tool asks for approval, `y` allows once, `a` always for the session, and
`n` or `esc` denies.

The line REPL (`--no-tui` or `ANYCODE_NO_TUI=1`) supports the same commands, `\`
line continuations, and Ctrl+C interruption.

Slash commands:

```
/help              Show help
/new               Start a new session (alias: /clear)
/models            Browse models for the active provider
/connect           Choose a provider, enter its API key, and connect
/delete-provider <id>  Delete a saved custom provider preset
/sessions          Open the session picker (TUI) or list sessions
/resume [id]       Resume a session (default: most recent)
/yolo              Toggle auto-approve for the rest of the session
/usage             Show token usage
/tools             List available tools
/mcp               Show MCP server status
/plugins [name]    Show loaded plugins (or one plugin's log)
/exit              Quit (alias: /quit)
```

## Tools and permissions

| Tool | Read-only | What it does |
| --- | --- | --- |
| `read` | yes | Read a text file with line numbers, paged via `offset`/`limit` |
| `glob` | yes | Find files by glob, newest first |
| `grep` | yes | Regex search with ripgrep when available, built-in fallback |
| `websearch` | yes | Keyless DuckDuckGo search returning titles, URLs and snippets |
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
3. Provider-specific key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
   `ANYROUTE_API_KEY`)
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

### MCP servers

anycode speaks MCP over stdio (newline-delimited JSON-RPC 2.0). Configure
servers in `~/.anycode/mcp.json` (global) and/or `<cwd>/.anycode/mcp.json`
(project). Project entries replace global entries with the same name.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me/project"],
      "env": { "TOKEN": "..." },
      "timeoutMs": 60000
    },
    "disabled-example": { "command": "some-server", "disabled": true }
  }
}
```

- Each MCP tool becomes `mcp__<server>__<tool>` (unsafe characters become `_`).
- Servers start once at startup, in parallel. A broken server is reported by
  `/mcp` and never blocks startup or other servers.
- Tools that are not marked `readOnlyHint` ask for approval like other mutating
  tools. `--yolo` skips prompts.
- `cwd` is resolved relative to the project directory; `env` is merged over the
  current environment. `timeoutMs` defaults to 60 seconds per request.

### Plugins

anycode loads `*.mjs` / `*.js` files from `~/.anycode/plugins/` and
`<cwd>/.anycode/plugins/` once at startup. A plugin default-exports a function
(or an object with `setup`/`activate`) that receives the plugin API.

```js
export default function (api) {
  api.registerTool({
    name: "deploy",
    description: "Deploy the current branch",
    parameters: {
      type: "object",
      properties: { env: { type: "string" } },
      required: ["env"],
    },
    async execute(input, ctx) {
      const ok = await ctx.approve({
        tool: "deploy",
        kind: "plugin",
        title: `Deploy to ${input.env}`,
      });
      if (!ok) throw new Error("deploy denied");
      return `deployed to ${input.env}`;
    },
  });

  api.registerCommand({
    name: "deploy-status",
    description: "Show deploy status",
    run(args, context) {
      context.log(`status requested for ${args || "staging"}`);
      return `status: ${args || "staging"}`;
    },
  });

  api.on("tool_end", ({ event }) => api.log(`ran ${event.call.name}`));
  api.onCleanup(() => {
    // close connections, flush files, ...
  });
}
```

- `api.registerTool` adds a tool the model can call. Set `readOnly: true` when it
  never mutates state; otherwise call `ctx.approve` yourself.
- `api.registerCommand` adds a slash command. Plugin commands appear in the
  command palette and `/plugins`; built-in commands win on name collisions.
- Hooks: `turn_start`, `turn_end`, `tool_start`, `tool_end`. Hook errors are
  recorded in the plugin log and never interrupt a turn.
- Plugin tools that collide with built-in or MCP tool names are ignored.
- `api.log` lines are visible with `/plugins <name>`.

### Project rules

At startup anycode reads, in order, the first of `AGENTS.md`, `CLAUDE.md`, or
`.anycode/AGENTS.md` in the working directory, plus `~/.anycode/AGENTS.md`, and
adds them to the system prompt. Use this for build commands, style rules, and
things the agent should never touch.

## Sessions

Sessions live in `<cwd>/.anycode/sessions/<id>.json` and contain the full
message history plus token usage. They are written after every tool step.

By default, running `anycode` will auto-open the most recent session if one
exists, so you can simply resume where you left off. Use the commands below to
control session behavior:

```bash
anycode sessions          # list saved sessions
anycode resume            # most recent session
anycode resume <id>       # specific session
anycode --session <id>    # resume specific session
anycode --continue        # most recent session (explicit)
anycode -s <id>           # resume specific session
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
`tool_start`, `tool_end`, `file_change`, `usage`, `compaction`, `notice`,
`error`, `done`. Providers only need to implement `Provider.stream(request)` and
yield `ProviderEvent`s.

## Architecture

```
src/
  cli.ts              executable bootstrap (sets NO_COLOR before imports)
  main.ts             CLI parsing, one-shot/JSON modes, TUI/REPL wiring
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
    openai.ts         OpenAI Chat Completions provider (also AnyRoute/Ollama)
    mock.ts           deterministic provider for tests
  tools/              read, write, edit, bash, glob, grep, websearch
  ui/
    tui.ts            full-screen runtime: alt screen, keys, streaming, approvals
    screen.ts         pure frame layout, composer, cursor composition
    transcript.ts     transcript blocks, markdown-lite, tool rendering
    editor.ts         multi-line composer with history and kill bindings
    keys.ts           incremental key/paste parser for raw terminal input
    commands.ts       shared slash-command handler
    runtime.ts        chat state shared by the TUI and REPL
    repl.ts           line REPL fallback
    renderer.ts       streaming renderer used by the REPL
  util/               ANSI, diff, glob, SSE, spinner, text, width, wrap
test/                 unit, provider, agent, TUI, and CLI end-to-end tests
```

The loop is deliberately small: send history → stream text/tool calls → execute
tools → append results → repeat until the model stops, the step limit is hit, or
the user aborts. Every provider is converted into the same event stream, so the
agent never branches on vendor.

The UI is layered the same way: `tui.ts` owns the terminal lifecycle and input,
`screen.ts` composes a deterministic frame from plain data, and `transcript.ts`
renders cached blocks. Because frames are pure, layout and scrolling are covered
by tests without a pseudo-terminal.

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
