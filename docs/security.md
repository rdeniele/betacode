# Security

BetaCode executes model-chosen actions. Treat the model as untrusted.

| Threat | Mitigation |
|---|---|
| Path traversal / symlink escape | `Workspace.resolve` normalises, checks containment, and resolves symlinks on the deepest existing ancestor |
| Secrets exposure | `.env*`, keys, `.ssh` etc. are not read without approval and are excluded from search; child processes get an environment without secret-like variables; logs and the DB redact secrets |
| Destructive commands | classifier plus mandatory approval; no config can relax it |
| Prompt injection via files or output | the prompt marks tool results as data; every action still passes permissions |
| Env manipulation | model-supplied env cannot set `PATH`, `NODE_OPTIONS`, `LD_PRELOAD`, secret-like names |
| Runaway processes | timeouts, cancellation (process-tree kill), output caps |
| Local API abuse from web pages | loopback bind, `Host` and `Origin` allow-lists |
| Credential storage | API keys are memory-only or come from the environment; `saveConfig` never writes them |

Known limits: the classifier is heuristic (anything unrecognised asks); approvals cannot see inside scripts that a command runs; the optional user terminal runs commands with your full environment by design.
