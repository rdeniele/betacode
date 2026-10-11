# BetaCode

**AI coding agent for your projects.**

BetaCode is an independent, open-source coding agent. You open a project, describe what you want, and BetaCode inspects the code, edits files, runs your tests, reads the failures, fixes them and reports what actually happened — with every change shown as a diff and every risky action behind an approval.

It is **local-first**: it talks to any OpenAI-compatible endpoint, and the default is a local [Qwen3-Coder-30B-A3B-Instruct](https://huggingface.co/Qwen/Qwen3-Coder-30B-A3B-Instruct) server. **No API key is needed for local models.** BetaCode is not affiliated with Anthropic or any other vendor; the architecture was informed by the public concepts of tools like OpenCode, with its own code, UI and prompts.

## Status

Working MVP. What exists and is tested:

| Area | State |
|---|---|
| Agent loop (plan → inspect → edit → run → observe → fix → report), cancellation, step limit, retry limit | ✅ |
| Tools: list/read/write/edit/delete/move/copy files, create dir, search (ripgrep or built-in), find files, run command, git status/diff/log/branch/checkout/add/commit/push/pull, diagnostics, plan, delegate | ✅ |
| OpenAI-compatible + Qwen provider, streaming, tool calls (incl. text-format fallback) | ✅ |
| Permissions: safe / confirm / dangerous, allow once / session / always, per-tool overrides | ✅ |
| Diffs, accept / reject / undo / redo from file snapshots | ✅ |
| Sessions in SQLite (Prisma): resume, rename, duplicate, delete, search, auto-compaction | ✅ |
| Project detection, `BETACODE.md` instructions, `/init` | ✅ |
| CLI (`betacode`, `init`, `config`, `models`, `sessions`, `doctor`) | ✅ |
| Desktop UI: chat, file tree, Monaco editor, changes, git, xterm terminal, command palette, settings, local-AI setup | ✅ in the browser; Tauri shell is scaffolded |
| Hardware-aware setup advisor: detects RAM/GPU, ranks local models with estimated speed, saves Ollama settings, downloads the model with progress | ✅ |
| Project memory (`remember` tool, `.betacode/memory.md`) and a check that reports do not claim commands that never ran | ✅ |
| Themes (Midnight, Slate, Paper), interface font and density; collapsible sidebar; welcome screen; model picker | ✅ |
| Optional helper model: a stronger hosted model can take over when the local one is stuck, only after you agree | ✅ |
| API keys for hosted providers, optionally remembered encrypted with Windows DPAPI | ✅ (Windows) |
| LSP, MCP, browser tool, web tools, remote agents | ❌ not implemented (see [Roadmap](#roadmap)) |

Honest limits: the terminal runs one command per line (it is not an interactive PTY); diagnostics only cover TypeScript projects; Anthropic and Gemini are reached through their OpenAI-compatible endpoints (their native APIs are not implemented); the Windows installer is the only packaged target so far (macOS/Linux builds are untested).

## Acknowledgements and reference projects

The agent design was informed by the public concepts of [OpenCode](https://github.com/opencode-ai/opencode) (MIT) and [Odysseus](https://github.com/odysseus-dev/odysseus) (hardware-fit model recommendations, project memory, result-integrity checks, the shape of the interface). **No code was copied from either project.** Odysseus is AGPL-3.0, so BetaCode only borrows ideas and re-implements them from scratch; keep it that way unless you are prepared to relicense.

## Architecture

```
 ┌──────────────┐   ┌──────────────┐
 │ Desktop UI   │   │ CLI          │         UI never talks to a model.
 │ React+Tauri  │   │ terminal     │
 └──────┬───────┘   └──────┬───────┘
        │ HTTP + SSE       │ in-process
        ▼                  ▼
 ┌─────────────────────────────────────────┐
 │ @betacode/server  App service           │  sessions, permissions broker,
 │  (database, event bus, slash commands)  │  config, terminal, doctor
 └──────────────────┬──────────────────────┘
                    ▼
 ┌─────────────────────────────────────────┐
 │ @betacode/agent   Agent loop            │  states, context budget,
 │  PermissionManager · ContextManager     │  compaction, sub-agents
 └───────┬───────────────┬─────────────────┘
         ▼               ▼
 ┌──────────────┐  ┌──────────────────────────────────────────┐
 │ @betacode/ai │  │ @betacode/tools  (Zod-validated registry)│
 │ providers    │  └─┬──────────┬──────────┬──────────┬───────┘
 └──────┬───────┘    ▼          ▼          ▼          ▼
        │        filesystem  terminal     git      project
        ▼        (workspace  (runner +   (CLI)    (detect +
  OpenAI-compatible  sandbox,  command             BETACODE.md)
  endpoint (local)   changes)  classifier)
```

| Package | Responsibility |
|---|---|
| `shared` | types, events, secret redaction, structured logger |
| `ai` | `AIProvider` interface, OpenAI-compatible + Qwen providers, SSE streaming |
| `tools` | tool registry and every built-in tool |
| `filesystem` | workspace boundary, file service, ignore rules, search, diff, change tracker |
| `terminal` | process runner (timeout/cancel/env filter) and command risk classifier |
| `git` | git CLI wrapper |
| `project` | framework detection, `BETACODE.md` discovery |
| `prompts` | all agent-facing instructions |
| `config` | layered configuration |
| `database` | Prisma + SQLite access (the only package that touches the DB) |
| `agent` | agent loop, permissions, context/compaction, session assembly |
| `server` | application service, HTTP/SSE API, doctor |

See [docs/](docs/) for details.

## Install as an app (Windows)

Run `BetaCode_0.1.0_x64-setup.exe` (built at `apps/desktop/src-tauri/target/release/bundle/nsis/`). It bundles the UI, a Node runtime and the database engine, so Node, pnpm and Rust are not needed on the target machine. You still need a model server such as Ollama (see below). To rebuild the installer: `pnpm package` (needs Rust and the NSIS tooling Tauri downloads on first use). The app logs the runtime startup to `~/.betacode/logs/runtime-stdio.log`.

The installer is unsigned, so Windows SmartScreen may warn on first run.

## Quick start (from source)

Requirements: Node 20+, pnpm 9, Git. Optional: ripgrep (faster search). Rust is only needed for the Tauri desktop shell.

```bash
pnpm install
pnpm db:generate        # generates the Prisma client
```

### 1. Run a local model (no API key)

BetaCode needs an OpenAI-compatible server. It never downloads model weights for you. Pick one (details in [docs/local-model.md](docs/local-model.md)):

```bash
# vLLM
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct --max-model-len 32768 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --port 8000

# Ollama  (then set model to qwen3-coder:30b and endpoint to http://localhost:11434/v1)
ollama pull qwen3-coder:30b
```

The weights are open under the model's license, but running a 30B model needs capable local hardware (a quantised build helps). Hosted inference, if you prefer it, is separate and may require a key and may be rate-limited.

### 2. Use the CLI

```bash
pnpm cli doctor                 # checks Node, Git, DB, endpoint, model
pnpm cli ./my-project           # interactive session
pnpm cli ./my-project -p "Add a /health endpoint and run the tests" --yes
```

### 3. Use the desktop UI

```bash
pnpm dev                        # runtime on :4317 + UI on :1420
# open http://localhost:1420, or: pnpm --filter @betacode/desktop tauri dev
```

## Configuration

`~/.betacode/config.json` (global) → `./.betacode/config.json` (project) → environment. See [docs/configuration.md](docs/configuration.md).

```json
{
  "provider": "qwen",
  "model": "Qwen/Qwen3-Coder-30B-A3B-Instruct",
  "baseUrl": "http://localhost:8000/v1",
  "temperature": 0.7, "topP": 0.8, "topK": 20, "repetitionPenalty": 1.05,
  "contextLength": 32768,
  "maxIterations": 30, "maxRetries": 5,
  "permissions": { "write_file": "confirm", "delete_file": "dangerous" }
}
```

Environment: `BETA_CODE_BASE_URL`, `BETA_CODE_MODEL`, `BETA_CODE_API_KEY` (optional), `BETA_CODE_PROVIDER`.

Put project rules in `BETACODE.md` at the repo root; BetaCode reads it every run.

## Security

BetaCode runs commands and edits files, so it is conservative by default. Summary (full model in [docs/security.md](docs/security.md)):

- All file paths are confined to the project (`..`, absolute paths and symlinks that escape are blocked).
- Model output is untrusted: every tool call is schema-validated; tool results are treated as data, not instructions.
- Shell commands are classified; read-only ones run, others ask, dangerous ones (`rm -rf`, `sudo`, `git push`, destructive SQL, deploys …) always ask and can never be relaxed by config or "always allow".
- `.env`, keys and credentials are not read without explicit approval; child processes get a filtered environment; logs redact secrets.
- API keys are held in memory (or read from the environment), never written to disk.
- The runtime binds to loopback and rejects foreign `Host`/`Origin` headers.

## Development

```bash
pnpm test         # all packages + desktop UI tests
pnpm typecheck
pnpm dev          # runtime + UI
```

Tests cover the agent loop, tools, filesystem boundary, terminal, permissions, context compaction, git, AI streaming, database, CLI, UI components, and an end-to-end run (HTTP API → agent → streaming provider → real tools → real `npm test` failure and fix). See [docs/development.md](docs/development.md).

## Roadmap

- LSP manager (diagnostics beyond TypeScript, definitions, references, symbols)
- MCP client (external tools treated as untrusted and permission-gated)
- Browser tool, `fetch_url` / web search (permission-gated)
- Tauri sidecar bundling of the runtime; interactive PTY terminal
- Native Anthropic / Gemini providers; cost display with configured pricing is already supported
- Remote agents, parallel sub-agents

## Contributing

Issues and PRs are welcome. Keep modules small and typed, add tests with behaviour changes, never fake functionality (unimplemented things say "not implemented yet"), and keep provider-specific code out of the agent.

## License

MIT — see [LICENSE](LICENSE).
