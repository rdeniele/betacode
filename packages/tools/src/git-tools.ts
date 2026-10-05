import { formatStatus } from "@betacode/git";
import { BetaCodeError, z } from "@betacode/shared";
import type { AgentTool } from "./types";
import { guard, truncate } from "./util";

const empty = z.object({});

async function requireRepo(ctx: Parameters<AgentTool["execute"]>[1]): Promise<void> {
  if (!(await ctx.git().isRepo())) throw new BetaCodeError("This project is not a git repository.", "NOT_A_REPO");
}

export const gitStatus: AgentTool<z.infer<typeof empty>> = {
  name: "git_status",
  description: "Show the current branch and which files are modified, staged or untracked.",
  schema: empty,
  kind: "git",
  readOnly: true,
  assess: () => ({ level: "safe", summary: "git status" }),
  execute: (_a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      const s = await ctx.git().status();
      return { ok: true, content: formatStatus(s), data: s };
    }),
};

const diffSchema = z.object({
  staged: z.boolean().optional().describe("Show staged changes instead of unstaged."),
  path: z.string().optional().describe("Limit the diff to one path."),
});

export const gitDiff: AgentTool<z.infer<typeof diffSchema>> = {
  name: "git_diff",
  description: "Show uncommitted changes as a unified diff.",
  schema: diffSchema,
  kind: "git",
  readOnly: true,
  assess: () => ({ level: "safe", summary: "git diff" }),
  execute: (a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      const path = a.path ? ctx.workspace.rel(ctx.workspace.resolve(a.path)) : undefined;
      const d = await ctx.git().diff({ staged: a.staged, path });
      return { ok: true, content: d.trim() ? truncate(d, 30_000) : "No differences." };
    }),
};

const logSchema = z.object({ limit: z.coerce.number().int().positive().max(100).optional() });

export const gitLog: AgentTool<z.infer<typeof logSchema>> = {
  name: "git_log",
  description: "Show recent commits.",
  schema: logSchema,
  kind: "git",
  readOnly: true,
  assess: () => ({ level: "safe", summary: "git log" }),
  execute: (a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      const log = await ctx.git().log(a.limit ?? 15);
      return { ok: true, content: log.length ? log.map((c) => `${c.shortHash} ${c.date.slice(0, 10)} ${c.author}: ${c.subject}`).join("\n") : "No commits yet.", data: log };
    }),
};

const branchSchema = z.object({
  create: z.string().optional().describe("Create and switch to this new branch. Omit to just list branches."),
});

export const gitBranch: AgentTool<z.infer<typeof branchSchema>> = {
  name: "git_branch",
  description: "List branches, or create and switch to a new branch with `create`.",
  schema: branchSchema,
  kind: "git",
  readOnly: false,
  assess: (a) => (a.create ? { level: "confirm", summary: `Create branch ${a.create}`, grantKey: "git_branch" } : { level: "safe", summary: "git branch" }),
  execute: (a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      if (a.create) {
        await ctx.git().checkout(a.create, { create: true });
        return { ok: true, content: `Created and switched to branch ${a.create}.` };
      }
      const b = await ctx.git().branches();
      return { ok: true, content: b.map((x) => `${x.current ? "*" : " "} ${x.name}${x.remote ? " (remote)" : ""}`).join("\n") || "No branches." };
    }),
};

const checkoutSchema = z.object({ branch: z.string().min(1) });

export const gitCheckout: AgentTool<z.infer<typeof checkoutSchema>> = {
  name: "git_checkout",
  description: "Switch to an existing branch.",
  schema: checkoutSchema,
  kind: "git",
  readOnly: false,
  assess: (a) => ({ level: "confirm", summary: `git checkout ${a.branch}`, grantKey: "git_checkout" }),
  execute: (a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      const out = await ctx.git().checkout(a.branch);
      return { ok: true, content: out || `Switched to ${a.branch}.` };
    }),
};

const addSchema = z.object({ paths: z.array(z.string()).min(1) });

export const gitAdd: AgentTool<z.infer<typeof addSchema>> = {
  name: "git_add",
  description: "Stage files for commit.",
  schema: addSchema,
  kind: "git",
  readOnly: false,
  assess: (a) => ({ level: "confirm", summary: `git add ${a.paths.join(" ")}`, grantKey: "git_add" }),
  execute: (a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      const paths = a.paths.map((p) => ctx.workspace.rel(ctx.workspace.resolve(p)));
      await ctx.git().add(paths);
      return { ok: true, content: `Staged: ${paths.join(", ")}` };
    }),
};

const commitSchema = z.object({ message: z.string().min(1).describe("Commit message.") });

export const gitCommit: AgentTool<z.infer<typeof commitSchema>> = {
  name: "git_commit",
  description: "Commit the currently staged changes. Only do this when the user asked for a commit.",
  schema: commitSchema,
  kind: "git",
  readOnly: false,
  assess: (a) => ({ level: "confirm", summary: `git commit -m "${a.message}"` }),
  execute: (a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      const r = await ctx.git().commit(a.message);
      return { ok: true, content: `Committed ${r.hash}: ${r.summary}` };
    }),
};

const pushSchema = z.object({ remote: z.string().optional(), branch: z.string().optional() });

export const gitPush: AgentTool<z.infer<typeof pushSchema>> = {
  name: "git_push",
  description: "Push commits to a remote. Always requires explicit user approval.",
  schema: pushSchema,
  kind: "git",
  readOnly: false,
  assess: (a) => ({ level: "dangerous", summary: `git push${a.remote ? ` ${a.remote}` : ""}${a.branch ? ` ${a.branch}` : ""}`, reason: "Publishes commits to a remote repository." }),
  execute: (a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      return { ok: true, content: (await ctx.git().push(a)) || "Pushed." };
    }),
};

export const gitPull: AgentTool<z.infer<typeof empty>> = {
  name: "git_pull",
  description: "Fast-forward pull from the upstream branch.",
  schema: empty,
  kind: "git",
  readOnly: false,
  assess: () => ({ level: "confirm", summary: "git pull --ff-only", grantKey: "git_pull" }),
  execute: (_a, ctx) =>
    guard(async () => {
      await requireRepo(ctx);
      return { ok: true, content: (await ctx.git().pull()) || "Already up to date." };
    }),
};
