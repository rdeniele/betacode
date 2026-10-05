import { spawnSync } from "node:child_process";
import { accessSync, constants } from "node:fs";
import type { App } from "./app";

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

function version(cmd: string, args = ["--version"]): string | undefined {
  try {
    // On Windows, npm/pnpm are .cmd shims and need a shell; the command line is a fixed literal, so joining is safe.
    const r =
      process.platform === "win32"
        ? spawnSync([cmd, ...args].join(" "), { encoding: "utf8", shell: true, windowsHide: true, timeout: 8000 })
        : spawnSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 8000 });
    if (r.status === 0) return (r.stdout || r.stderr).trim().split("\n")[0];
  } catch {
    /* not installed */
  }
  return undefined;
}

/** Environment diagnostics. Every result reflects a real check; nothing is assumed. */
export async function runDoctor(app: App): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  const major = Number(process.versions.node.split(".")[0]);
  out.push({ name: "Node.js", status: major >= 20 ? "ok" : "fail", detail: `v${process.versions.node}${major >= 20 ? "" : " (Node 20+ required)"}` });

  const pnpm = version("pnpm");
  const npm = version("npm");
  out.push(pnpm || npm ? { name: "Package manager", status: "ok", detail: [pnpm && `pnpm ${pnpm}`, npm && `npm ${npm}`].filter(Boolean).join(", ") } : { name: "Package manager", status: "warn", detail: "neither pnpm nor npm found on PATH" });

  const git = version("git");
  out.push(git ? { name: "Git", status: "ok", detail: git } : { name: "Git", status: "fail", detail: "git not found on PATH (git tools will not work)" });

  const rg = version("rg");
  out.push(rg ? { name: "ripgrep", status: "ok", detail: rg } : { name: "ripgrep", status: "warn", detail: "not installed; search falls back to a slower built-in searcher" });

  try {
    await app.db.prisma.$queryRawUnsafe("SELECT 1");
    out.push({ name: "SQLite database", status: "ok", detail: "reachable" });
  } catch (e) {
    out.push({ name: "SQLite database", status: "fail", detail: (e as Error).message });
  }

  try {
    const cfg = app.config();
    out.push({ name: "Configuration", status: "ok", detail: `${cfg.provider} · ${cfg.model} · ${cfg.contextLength} token context` });
    const t = await app.testConnection();
    out.push(t.ok ? { name: "AI endpoint", status: "ok", detail: `${cfg.baseUrl} reachable (${t.latencyMs} ms, ${t.models.length} model(s))` } : { name: "AI endpoint", status: "fail", detail: `${cfg.baseUrl}: ${t.error}` });
    if (t.ok) {
      out.push(
        t.modelAvailable
          ? { name: "Model available", status: "ok", detail: cfg.model + (t.contextLength ? ` (server context ${t.contextLength})` : "") }
          : { name: "Model available", status: "warn", detail: `"${cfg.model}" is not in the server's model list${t.models.length ? ` (found: ${t.models.slice(0, 5).join(", ")})` : ""}` },
      );
    }
  } catch (e) {
    out.push({ name: "Configuration", status: "fail", detail: (e as Error).message });
  }

  if (app.project) {
    try {
      accessSync(app.project.root, constants.R_OK | constants.W_OK);
      out.push({ name: "Project permissions", status: "ok", detail: `read/write access to ${app.project.root}` });
    } catch {
      out.push({ name: "Project permissions", status: "fail", detail: `cannot read/write ${app.project.root}` });
    }
    if (app.project.info.languages.includes("Python")) {
      const py = version("python") ?? version("python3");
      out.push(py ? { name: "Python", status: "ok", detail: py } : { name: "Python", status: "warn", detail: "project uses Python but python is not on PATH" });
    }
  }
  return out;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: "✓", warn: "!", fail: "✗" } as const;
  return ["BetaCode Doctor", "", ...checks.map((c) => `${icon[c.status]} ${c.name}: ${c.detail}`)].join("\n");
}
