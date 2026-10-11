# Agent

`packages/agent/src/agent.ts`.

## Loop

```
while steps < maxIterations:
  compact context if near the limit
  response = stream(model, history, tools)
  no tool calls → finish "completed"
  for each tool call: parse → validate → assess → permission → execute → append result
  denied → finish "permission_denied" (remaining calls answered "skipped")
  cancelled → finish "cancelled"
```

## Stop reasons

`completed`, `cancelled`, `permission_denied`, `max_iterations`, `error` (model failure, repeated invalid calls, or the same call failing 4 times with identical arguments).

## States

`IDLE THINKING PLANNING READING SEARCHING EDITING RUNNING TESTING WAITING_FOR_PERMISSION RECOVERING COMPLETED FAILED CANCELLED`, emitted as `agent.state`.

## Error recovery

Failures are returned to the model verbatim (exit code, stdout, stderr; "oldText not found" for edits; schema errors for bad arguments). After `maxRetries` consecutive failing test/build/lint runs the agent loses its tools for one turn and must write a final report instead of retrying forever.

## Modes

`ask`, `plan`, `review`, `explore` only receive read-only tools. `code` and `debug` receive all tools.

## Sub-agents

`delegate_task` runs a fresh agent with its own history, read-only tools and a task prompt, max 12 steps, no further delegation. Only its summary returns to the parent.

## Context management

`ContextManager` estimates tokens (calibrated against real usage), prunes old tool output first, then summarises older turns into *Task / Completed / Files modified / Current errors / Important decisions / Next action*. If the model cannot summarise, a deterministic fallback built from the transcript and change tracker is used. The kept tail never splits a tool-call exchange. The summary persists with the session so resume works.

## What makes the agent more reliable (especially with small local models)

- **Rich prompt**: working method, hard rules, style, plus the project tree, detected commands, date, git state and BETACODE.md up front (short variant for contexts of 8K or less).
- **Read before edit**: `edit_file` and overwriting `write_file` are refused unless the file was read in this session and has not changed since. This stops edits based on imagined content.
- **Tolerant edits**: if `oldText` only differs in indentation and matches exactly one place, it is applied and re-indented, and the model is told.
- **Instant syntax feedback**: after each write/edit, JS/TS/JSON/Python files are syntax-checked and a failure is reported in the tool result.
- **Verification gate**: if the agent tries to finish after editing without running a test/typecheck/lint/build command, it is reminded once (only when the project has such commands).
- **Failed-check recovery**: in code/debug mode, an attempted final answer after a failed verification receives one reminder to diagnose, fix and rerun it, or explicitly report the blocker. A passing check clears the failure. The reminder is bounded so unresolved failures can still be reported.
- **Read/search loop recovery**: three repetitions of an unchanged observation or a cycle of up to four observations trigger a change-of-approach reminder to the current model. Results and normalized arguments are fingerprinted locally; successful mutations reset the observation window. A second cycle stops the run through the existing stuck-agent handling. No additional provider or internet access is needed.
- **Parallel reads**: independent read-only tool calls in one turn run concurrently.
- **No foreground servers**: `npm run dev`, watchers and similar are refused with advice, since they never exit.
- **Prompt truncation detection**: warns when the server reads far fewer tokens than were sent.
- Inline `<think>` blocks are stripped from history to save context.
- **Honest reports**: if the final report names a command (for example `git status`) that no tool call ran, the agent is asked once to correct it.
- **Project memory**: the `remember` tool (user-approved) saves verified facts to `.betacode/memory.md`; they are included in every later prompt.

## Helper model ("teacher") escalation

A small local model can get stuck. If a helper model is configured (Settings → Helper model), then when the agent hits one of these it *asks the user* whether the helper may take over for the rest of that run:

- the same tool call failed 4 times with identical arguments,
- 5 invalid tool calls in a row,
- the project's checks still fail after `maxRetries` attempts.

The consent prompt names the helper and the host the conversation will be sent to (the whole conversation, including file contents the agent read). Nothing is sent before the user agrees; "deny" falls back to the normal stop. It happens at most once per run, never in sub-agents, and the next run starts on the local model again. The helper uses the same tools, permissions and history, with its own sampling defaults.

Its API key is stored separately from the main model's key (same encrypted store, keyed by host), or read from `BETA_CODE_TEACHER_API_KEY`. A helper on your own network needs no key. Enable it in config with `"teacher": { "enabled": true, "provider": "openai-compatible", "baseUrl": "...", "model": "..." }`.
