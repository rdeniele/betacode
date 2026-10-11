import type { AgentEvent, PermissionRequest } from "@betacode/shared";

export interface Style {
  dim(s: string): string;
  bold(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

export function makeStyle(color: boolean): Style {
  const wrap = (open: number, close: number) => (s: string) => (color ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { dim: wrap(2, 22), bold: wrap(1, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

export function colorDiff(diff: string, s: Style, maxLines = 40): string {
  const lines = diff.split("\n");
  const shown = lines.slice(0, maxLines).map((l) => (l.startsWith("+") && !l.startsWith("+++") ? s.green(l) : l.startsWith("-") && !l.startsWith("---") ? s.red(l) : l.startsWith("@@") ? s.cyan(l) : s.dim(l)));
  if (lines.length > maxLines) shown.push(s.dim(`… ${lines.length - maxLines} more lines`));
  return shown.join("\n");
}

function briefArgs(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const pick = a.path ?? a.command ?? a.query ?? a.pattern ?? a.from ?? a.task ?? a.message ?? a.create ?? a.branch;
  return typeof pick === "string" ? pick.replace(/\s+/g, " ").slice(0, 100) : name === "update_plan" ? "" : "";
}

/** Turns agent events into terminal output. Pure: all output goes through `write`. */
export class Renderer {
  private atLineStart = true;
  private streaming = false;
  private readonly names = new Map<string, string>();

  constructor(
    private readonly write: (s: string) => void,
    private readonly s: Style,
    private readonly opts: { verboseTools?: boolean } = {},
  ) {}

  private endLine(): void {
    if (!this.atLineStart) this.write("\n");
    this.atLineStart = true;
    this.streaming = false;
  }

  line(text: string): void {
    this.endLine();
    this.write(text + "\n");
  }

  handle(e: AgentEvent): void {
    const s = this.s;
    switch (e.type) {
      case "agent.text":
        this.streaming = true;
        this.write(e.delta);
        this.atLineStart = e.delta.endsWith("\n");
        break;
      case "tool.started":
        this.names.set(e.callId, e.name);
        this.line(`${s.cyan("▸")} ${s.bold(e.name)} ${s.dim(briefArgs(e.name, e.args))}`);
        break;
      case "tool.completed": {
        const mark = e.ok ? s.green("✓") : s.red("✗");
        const first = e.content.split("\n")[0] ?? "";
        const head = e.ok ? "" : ` ${s.red(first.slice(0, 120))}`;
        this.line(`  ${mark} ${s.dim(`${e.durationMs}ms`)}${head}`);
        if (this.opts.verboseTools && e.content) this.line(s.dim(e.content.split("\n").slice(0, 15).join("\n")));
        break;
      }
      case "file.changed":
        if (e.change.status === "pending") this.line(`  ${s.yellow(e.change.kind === "added" ? "A" : e.change.kind === "deleted" ? "D" : "M")} ${e.change.path} ${s.green(`+${e.change.additions}`)} ${s.red(`-${e.change.deletions}`)}`);
        break;
      case "plan.updated":
        this.line(s.bold("Plan:"));
        for (const p of e.plan) this.line(`  ${p.status === "done" ? s.green("✓") : p.status === "in_progress" ? s.yellow("●") : s.dim("○")} ${p.text}`);
        break;
      case "agent.state":
        if (e.state === "RECOVERING") this.line(s.yellow("↻ previous step failed — recovering"));
        break;
      case "session.compacted":
        this.line(s.dim("(context compacted)"));
        break;
      case "agent.notice":
        this.line(e.level === "warn" ? s.yellow(`⚠ ${e.message}`) : s.dim(e.message));
        break;
      case "model.error":
        this.line(s.red(`Model error: ${e.message}`));
        break;
      case "agent.completed": {
        this.endLine();
        const label: Record<string, string> = { completed: s.green("● Completed"), cancelled: s.yellow("● Cancelled"), permission_denied: s.yellow("● Stopped (permission denied)"), max_iterations: s.yellow("● Stopped (step limit)"), error: s.red("● Failed") };
        this.write(`${label[e.reason] ?? e.reason}${e.message && e.reason !== "completed" ? s.dim(` — ${e.message}`) : ""}\n`);
        break;
      }
      default:
        break;
    }
  }

  permissionPrompt(r: PermissionRequest): string {
    const s = this.s;
    const risk = r.riskLevel === "dangerous" ? s.red("DANGEROUS") : s.yellow("confirm");
    const lines = [`${s.bold("BetaCode wants to")} ${s.bold(r.tool)} ${s.dim(`[${risk}]`)}`, `  ${r.summary}`];
    if (r.reason) lines.push(s.dim(`  ${r.reason}`));
    if (r.detail) lines.push(colorDiff(r.detail, s));
    lines.push(s.dim(r.riskLevel === "dangerous" ? "[y] allow once  [s] allow this exact action for the session  [n] deny" : "[y] allow once  [s] allow for session  [a] always allow this tool  [n] deny  [N] never allow"));
    return lines.join("\n");
  }
}

export function parsePermissionAnswer(answer: string, risk: PermissionRequest["riskLevel"]): "allow_once" | "allow_session" | "always_allow" | "always_deny" | "deny" {
  const a = answer.trim();
  if (a === "N") return "always_deny";
  switch (a.toLowerCase()) {
    case "y":
    case "yes":
      return "allow_once";
    case "s":
    case "session":
      return "allow_session";
    case "a":
    case "always":
      return risk === "dangerous" ? "allow_session" : "always_allow";
    default:
      return "deny";
  }
}
