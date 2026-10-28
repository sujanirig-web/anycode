# anycode — agent instructions

## What this is

A terminal AI coding agent in plain TypeScript. No runtime dependencies; Node
built-ins only. Compiled with `tsc` to `dist/`.

## Commands

```bash
npm install
npm run typecheck   # must pass
npm test            # must pass
npm run build       # must pass before pushing
npm run dev -- "..." # run from source
```

## Conventions

- ESM only, `"type": "module"`, `.js` extensions on relative imports.
- Strict TypeScript: `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`.
- Keep provider-specific logic inside `src/llm/`; the agent must stay vendor-neutral.
- Convert every provider into `ProviderEvent`; never branch on vendor in the agent.
- Tools throw `ToolError(message, hint)` for recoverable failures so the model can retry.
- Mutating tools must call `ctx.approve(request)` before touching the filesystem.
- Resolve paths through `resolvePath(cwd, input)`; display through `displayPath`.
- Keep prose short, errors actionable, and output truncation in place.
- Do not add runtime dependencies without a strong reason.

## Layout

- `src/main.ts` — CLI modes and REPL wiring
- `src/agent/` — loop, prompt, sessions, permissions
- `src/llm/` — providers, HTTP streaming, mock
- `src/tools/` — read/write/edit/bash/glob/grep
- `src/ui/` — renderer, REPL, approval prompt
- `src/util/` — ANSI, diff, glob, SSE, spinner, text
- `test/` — unit, provider, agent, and CLI end-to-end tests

## Testing notes

- Tests use real local HTTP servers and the mock provider; no API keys needed.
- The CLI E2E test spawns `node --import tsx src/cli.ts`, so `cwd` must be the
  project root for `tsx` to resolve.
- Windows is a supported target: use `path`, `toPosix`, and `shell: true`
  rather than assuming POSIX paths or shells.

## Safety

- Never commit `.env`, keys, or session files under `.anycode/sessions/`.
- Do not weaken approval gates to make a test pass.
- Do not bypass failing tests or type checks.
