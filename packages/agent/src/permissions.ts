import { randomUUID } from "node:crypto";
import type { AgentEvent, PermissionDecision, PermissionLevel, PermissionRequest } from "@betacode/shared";
import type { AgentTool, PermissionAssessment } from "@betacode/tools";

export interface PermissionRule {
  tool: string;
  decision: "allow" | "deny";
}

/** Persistence for "always allow / always deny" choices. */
export interface RuleStore {
  list(): PermissionRule[];
  set(tool: string, decision: "allow" | "deny"): void;
}

export class MemoryRuleStore implements RuleStore {
  private readonly rules = new Map<string, PermissionRule>();
  list(): PermissionRule[] {
    return [...this.rules.values()];
  }
  set(tool: string, decision: "allow" | "deny"): void {
    this.rules.set(tool, { tool, decision });
  }
}

/** Asks the user. Implemented by the UI (dialog) or the CLI (prompt). Must settle when `signal` aborts. */
export type PermissionPrompter = (request: PermissionRequest, signal: AbortSignal) => Promise<PermissionDecision>;

export interface PermissionOptions {
  prompter?: PermissionPrompter;
  /** Per-tool level overrides from configuration; "deny" blocks the tool entirely. */
  overrides?: Record<string, PermissionLevel | "deny">;
  rules?: RuleStore;
  /**
   * Non-interactive approval policy.
   * - "none": always ask (default)
   * - "confirm": auto-approve confirm-level actions (CLI `--yes`); dangerous actions still need an explicit yes
   */
  autoApprove?: "none" | "confirm";
  emit?: (e: AgentEvent) => void;
}

export interface PermissionOutcome {
  allowed: boolean;
  /** Message for the model when not allowed. */
  message?: string;
  /** True when the user (or a rule) refused, as opposed to a tool being unavailable. */
  denied?: boolean;
}

/**
 * Decides whether a tool call may run:
 *  safe → run; confirm/dangerous → ask the user unless a session grant or persistent rule applies.
 *  Dangerous actions are never covered by blanket "always allow" rules and session grants only match
 *  the exact same action.
 */
export class PermissionManager {
  private readonly sessionGrants = new Set<string>();
  private prompter?: PermissionPrompter;

  constructor(private readonly opts: PermissionOptions = {}) {
    this.prompter = opts.prompter;
  }

  setPrompter(p: PermissionPrompter | undefined): void {
    this.prompter = p;
  }

  setOverrides(o: Record<string, PermissionLevel | "deny">): void {
    (this.opts as PermissionOptions).overrides = o;
  }

  setAutoApprove(mode: "none" | "confirm"): void {
    (this.opts as PermissionOptions).autoApprove = mode;
  }

  clearSessionGrants(): void {
    this.sessionGrants.clear();
  }

  effectiveLevel(tool: AgentTool, a: PermissionAssessment): PermissionLevel | "deny" {
    const override = this.opts.overrides?.[tool.name];
    if (!override) return a.level;
    if (override === "deny") return "deny";
    // Config can raise risk, or relax it for file tools; it can never relax a dangerous shell command.
    if (tool.kind === "run" && a.level === "dangerous") return "dangerous";
    return override;
  }

  async check(tool: AgentTool, a: PermissionAssessment, signal: AbortSignal): Promise<PermissionOutcome> {
    const level = this.effectiveLevel(tool, a);
    if (level === "deny") return { allowed: false, denied: true, message: `The "${tool.name}" tool is disabled by the user's permission settings.` };

    const rule = this.opts.rules?.list().find((r) => r.tool === tool.name);
    if (rule?.decision === "deny") return { allowed: false, denied: true, message: `The user has permanently denied the "${tool.name}" tool.` };

    if (level === "safe") return { allowed: true };

    const grantKey = a.grantKey ?? tool.name;
    if (level === "confirm") {
      if (rule?.decision === "allow") return { allowed: true };
      if (this.sessionGrants.has(grantKey)) return { allowed: true };
      if (this.opts.autoApprove === "confirm") return { allowed: true };
    } else if (this.sessionGrants.has(`${grantKey}\u0000exact:${a.summary}`)) {
      return { allowed: true };
    }

    if (!this.prompter) {
      return { allowed: false, denied: true, message: `Approval is required for: ${a.summary}, but no interactive approval is available. Re-run with approvals enabled.` };
    }

    const request: PermissionRequest = {
      id: randomUUID(),
      tool: tool.name,
      summary: a.summary,
      detail: a.detail,
      reason: a.reason,
      riskLevel: level,
      grantKey,
    };
    // Start the prompt first so it is registered before listeners hear about it (a listener may answer synchronously).
    const pending = this.prompter(request, signal);
    pending.catch(() => {});
    this.opts.emit?.({ type: "permission.requested", request });
    let decision: PermissionDecision;
    try {
      decision = await pending;
    } catch {
      decision = "deny";
    }
    if (signal.aborted) decision = "deny";
    this.opts.emit?.({ type: "permission.resolved", requestId: request.id, decision });

    switch (decision) {
      case "allow_once":
        return { allowed: true };
      case "allow_session":
        this.sessionGrants.add(level === "dangerous" ? `${grantKey}\u0000exact:${a.summary}` : grantKey);
        return { allowed: true };
      case "always_allow":
        if (level === "dangerous") {
          // Blanket rules never cover dangerous actions: treat as a session grant for this exact action.
          this.sessionGrants.add(`${grantKey}\u0000exact:${a.summary}`);
        } else {
          this.opts.rules?.set(tool.name, "allow");
        }
        return { allowed: true };
      case "always_deny":
        this.opts.rules?.set(tool.name, "deny");
        return { allowed: false, denied: true, message: `The user permanently denied the "${tool.name}" tool.` };
      default:
        return { allowed: false, denied: true, message: `The user denied this action (${a.summary}). Do not retry it or work around it. Explain what you wanted to do and ask how to proceed.` };
    }
  }
}
