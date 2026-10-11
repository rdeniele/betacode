import { classifyCommand, formatRunResult, runCommand } from "@betacode/terminal";
import { z } from "@betacode/shared";
import type { AgentTool } from "./types";
import { fail, guard, truncate } from "./util";

/** Commands that start a server or watcher and never exit on their own. */
export function looksLongRunning(command: string): boolean {
  const c = command.toLowerCase();
  const runner = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve|watch)\b/;
  const frameworks = /\b(next|vite|nuxt|astro|remix)\s+dev\b/;
  const watchers = /\b(nodemon|webpack\s+serve|ng\s+serve|live-server|cargo\s+watch)\b/;
  const servers = /\buvicorn\b|\bflask\s+run\b|\bmanage\.py\s+runserver\b|\bhttp\.server\b|\bphp\s+artisan\s+serve\b/;
  const watchFlag = /(^|\s)--watch(\s|$)/.test(c) && !/--run\b|--watch=false|--no-watch/.test(c);
  return runner.test(c) || frameworks.test(c) || watchers.test(c) || servers.test(c) || watchFlag;
}

const schema = z.object({
  command: z.string().min(1).describe("Shell command line to run."),
  cwd: z.string().optional().describe("Working directory relative to the project root (default: project root)."),
  timeoutSeconds: z.coerce.number().positive().max(1800).optional().describe("Kill the command after this many seconds."),
  env: z.record(z.string(), z.string()).optional().describe("Extra environment variables (PATH and secret-like names are not allowed)."),
});

export const runCommandTool: AgentTool<z.infer<typeof schema>> = {
  name: "run_command",
  description:
    "Run a shell command in the project and return stdout, stderr, exit code and duration. Use it to run tests, builds, linters and package managers. Read-only commands run immediately; others need user approval.",
  schema,
  kind: "run",
  readOnly: false,
  assess: (a) => {
    const risk = classifyCommand(a.command);
    return {
      level: risk.level,
      summary: a.command,
      reason: risk.level === "safe" ? undefined : risk.reason,
      // Session grants for commands are scoped to the exact command line.
      grantKey: `run_command:${a.command.trim()}`,
    };
  },
  execute: (a, ctx) =>
    guard(async () => {
      if (looksLongRunning(a.command) && !a.timeoutSeconds) {
        return fail(`"${a.command}" starts a long-running server or watcher and would never finish. Do not run dev servers in the foreground. Verify with a one-shot command instead (tests, build, typecheck, lint, or a script that exits). If you really must start it to check output, pass timeoutSeconds (for example 15).`);
      }
      const cwd = ctx.workspace.resolve(a.cwd ?? ".");
      const r = await runCommand({
        command: a.command,
        cwd,
        env: a.env,
        timeoutMs: a.timeoutSeconds ? a.timeoutSeconds * 1000 : ctx.commandTimeoutMs,
        signal: ctx.signal,
        onOutput: (chunk) => ctx.emit({ type: "tool.output", callId: ctx.callId, chunk }),
      });
      const ok = r.exitCode === 0 && !r.timedOut && !r.cancelled;
      return {
        ok,
        content: truncate(formatRunResult(a.command, r)),
        data: { exitCode: r.exitCode, durationMs: r.durationMs, timedOut: r.timedOut, cancelled: r.cancelled, signal: r.signal },
      };
    }),
};
