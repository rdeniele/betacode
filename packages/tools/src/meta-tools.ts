import { existsSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "@betacode/terminal";
import { z, type PlanItem } from "@betacode/shared";
import type { AgentTool } from "./types";
import { fail, guard, truncate } from "./util";

const planSchema = z.object({
  steps: z
    .array(z.object({ text: z.string().min(1), status: z.enum(["pending", "in_progress", "done"]) }))
    .min(1)
    .max(20)
    .describe("The full, current list of steps."),
});

export const updatePlan: AgentTool<z.infer<typeof planSchema>> = {
  name: "update_plan",
  description: "Record or update the task plan shown to the user. Send the complete list each time, marking progress. Use for multi-step work only.",
  schema: planSchema,
  kind: "plan",
  readOnly: true,
  assess: () => ({ level: "safe", summary: "Update plan" }),
  execute: async (a, ctx) => {
    const plan: PlanItem[] = a.steps.map((s) => ({ text: s.text, status: s.status }));
    ctx.plan.set(plan);
    ctx.emit({ type: "plan.updated", plan });
    return { ok: true, content: `Plan updated (${plan.filter((p) => p.status === "done").length}/${plan.length} done).` };
  },
};

const delegateSchema = z.object({ task: z.string().min(1).describe("A self-contained investigation task with all needed context.") });

export const delegateTask: AgentTool<z.infer<typeof delegateSchema>> = {
  name: "delegate_task",
  description: "Delegate a focused, read-only investigation to a sub-agent with its own context (e.g. \"Investigate how authentication works\"). Returns its summary.",
  schema: delegateSchema,
  kind: "agent",
  readOnly: true,
  assess: (a) => ({ level: "safe", summary: `Delegate: ${a.task.slice(0, 80)}` }),
  execute: (a, ctx) =>
    guard(async () => {
      if (!ctx.delegate) return fail("Delegation is not available here (sub-agents cannot delegate further).");
      const summary = await ctx.delegate(a.task, ctx.signal);
      return { ok: true, content: truncate(summary || "(sub-agent returned no summary)") };
    }),
};

const diagSchema = z.object({ path: z.string().optional().describe("Only report diagnostics for this file.") });

/** Parse `file(line,col): error TS1234: message` lines produced by tsc --pretty false. */
export function parseTscOutput(out: string): Array<{ file: string; line: number; column: number; severity: string; code: string; message: string }> {
  const items = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(out)) !== null) {
    items.push({ file: m[1]!.replace(/\\/g, "/"), line: Number(m[2]), column: Number(m[3]), severity: m[4]!, code: m[5]!, message: m[6]! });
  }
  return items;
}

export const getDiagnostics: AgentTool<z.infer<typeof diagSchema>> = {
  name: "get_diagnostics",
  description: "Get compiler diagnostics (errors/warnings) for the project. Currently supported for TypeScript projects via the local TypeScript compiler; other languages report that they are not supported yet.",
  schema: diagSchema,
  kind: "diagnostics",
  readOnly: true,
  assess: () => ({ level: "safe", summary: "Check diagnostics" }),
  execute: (a, ctx) =>
    guard(async () => {
      const root = ctx.workspace.root;
      const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
      if (!existsSync(join(root, "tsconfig.json"))) {
        return { ok: true, content: "Not implemented yet: diagnostics are only available for TypeScript projects (no tsconfig.json found). Run the project's own build/lint command with run_command instead." };
      }
      if (!existsSync(tsc)) {
        return { ok: true, content: "TypeScript is not installed in this project (node_modules/typescript missing). Install dependencies, or run the build with run_command." };
      }
      const r = await runCommand({ command: `node "${tsc}" --noEmit --pretty false`, cwd: root, timeoutMs: ctx.commandTimeoutMs, signal: ctx.signal });
      const all = parseTscOutput(r.stdout + "\n" + r.stderr);
      const filter = a.path ? ctx.workspace.rel(ctx.workspace.resolve(a.path)) : undefined;
      const items = filter ? all.filter((d) => d.file === filter) : all;
      if (!items.length) {
        return r.exitCode === 0 ? { ok: true, content: "TypeScript reports no errors." } : { ok: false, content: truncate(`tsc exited with code ${r.exitCode} but no diagnostics were parsed:\n${r.stdout}${r.stderr}`) };
      }
      const text = items.slice(0, 100).map((d) => `${d.file}:${d.line}:${d.column} ${d.severity} ${d.code}: ${d.message}`).join("\n");
      return { ok: false, content: `${items.length} diagnostic(s):\n${text}`, data: items };
    }),
};
