# Permissions

Levels: `safe` (runs), `confirm` (asks), `dangerous` (always asks).

Decisions: allow once, allow for session, always allow tool, always deny tool, deny.

- Session grants for `confirm` are per tool; for `dangerous` they match only the exact action.
- "Always allow" never applies to dangerous actions.
- Config overrides (`permissions`) can set a tool to `safe`, `confirm`, `dangerous` or `deny`. They can never relax a dangerous shell command.
- `--yes` (CLI) auto-approves `confirm` only.
- Denial stops the run (`permission_denied`); the model is told not to retry or work around it.
- Remembered choices are stored per project in SQLite and can be removed in Settings → Permissions.

Command classification (`packages/terminal/src/classify.ts`) splits compound commands and takes the highest risk. Dangerous: `sudo`, `rm -r/-f`, `chmod/chown`, `git push`, `git reset --hard`, `git clean -f`, destructive SQL and Prisma resets, `docker ... prune`, deploy/publish commands, pipe-to-shell, disk tools. Unknown commands default to `confirm`.
