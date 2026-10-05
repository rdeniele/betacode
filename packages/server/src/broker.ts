import type { PermissionPrompter } from "@betacode/agent";
import type { PermissionDecision, PermissionRequest } from "@betacode/shared";

interface Pending {
  sessionId: string;
  request: PermissionRequest;
  resolve: (d: PermissionDecision) => void;
}

/** Bridges the agent's approval requests to whoever is attached (UI dialog, CLI prompt). */
export class PermissionBroker {
  private readonly pending = new Map<string, Pending>();

  prompterFor(sessionId: string): PermissionPrompter {
    return (request, signal) =>
      new Promise<PermissionDecision>((resolve) => {
        const done = (d: PermissionDecision) => {
          this.pending.delete(request.id);
          signal.removeEventListener("abort", onAbort);
          resolve(d);
        };
        const onAbort = () => done("deny");
        if (signal.aborted) return done("deny");
        signal.addEventListener("abort", onAbort, { once: true });
        this.pending.set(request.id, { sessionId, request, resolve: done });
      });
  }

  /** Returns false if the request is unknown (already resolved or cancelled). */
  resolve(requestId: string, decision: PermissionDecision): boolean {
    const p = this.pending.get(requestId);
    if (!p) return false;
    p.resolve(decision);
    return true;
  }

  list(sessionId?: string): PermissionRequest[] {
    return [...this.pending.values()].filter((p) => !sessionId || p.sessionId === sessionId).map((p) => p.request);
  }

  denyAll(sessionId: string): void {
    for (const p of [...this.pending.values()]) if (p.sessionId === sessionId) p.resolve("deny");
  }
}
