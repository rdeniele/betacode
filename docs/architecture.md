# Architecture

BetaCode separates UI, agent runtime, model access, tools, permissions, context, storage and providers.

```
UI (desktop / CLI)  →  App service (@betacode/server)  →  Agent (@betacode/agent)
                                                              ├─ AIProvider (@betacode/ai)      ← replaceable
                                                              ├─ ToolRegistry (@betacode/tools)
                                                              ├─ PermissionManager
                                                              └─ ContextManager (budget + compaction)
Storage: SQLite via Prisma (@betacode/database) — only that package touches the DB.
```

## Rules

- The agent never imports a concrete provider. It receives an `AIProvider` (`chat`, `stream`, `supportsTools`, `getModels`).
- UIs consume `AgentEvent`s (`packages/shared/src/types.ts`). The desktop UI talks to the runtime over HTTP + Server-Sent Events; the CLI uses the same `App` in-process.
- Everything shown in the UI corresponds to real state: events come from real tool executions and real model streams.

## Request flow

1. UI → `POST /api/sessions/:id/messages` (or CLI) → `App.sendMessage`.
2. `AgentSession.run` refreshes git state and `BETACODE.md`, then `Agent.run` loops.
3. Each iteration: compact if needed → stream the model → record the assistant message → for each tool call: parse JSON → validate with Zod → `assess` risk → `PermissionManager.check` → execute → append the tool result.
4. Events (`agent.state`, `agent.text`, `tool.*`, `permission.*`, `file.changed`, `usage`, …) are persisted and broadcast.

## Why a Node runtime next to Tauri

The agent needs file, process and git access with strong safety checks. That logic is TypeScript and shared by the CLI and the desktop app, so the Tauri shell only hosts the UI and a native folder picker.
