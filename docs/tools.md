# Tools

Every tool has: `name`, `description`, a Zod `schema`, `kind`, `readOnly`, `assess(args)` (risk) and `execute(args)`.

| Tool | Level | Notes |
|---|---|---|
| list_directory | safe | respects `.gitignore` and built-in ignores |
| read_file | safe (dangerous for secrets files) | line numbers, size, language |
| write_file / edit_file | confirm | diff preview; edit needs exact `oldText` (unique unless `replaceAll`); a failing edit changes nothing and asks nothing |
| delete_file | dangerous | snapshot kept for revert |
| move_file / copy_file / create_directory | confirm | |
| search_files / find_files / search_code | safe | ripgrep when installed, JS fallback |
| run_command | classified | safe / confirm / dangerous per command |
| git_status / git_diff / git_log / git_branch (list) | safe | |
| git_add / git_commit / git_checkout / git_pull / git_branch (create) | confirm | |
| git_push | dangerous | |
| get_diagnostics | safe | TypeScript via local `tsc`; other languages answer "not implemented yet" |
| update_plan | safe | shown in the UI |
| delegate_task | safe | read-only sub-agent |

Add a tool by creating an `AgentTool` and registering it in `packages/tools/src/index.ts`.
