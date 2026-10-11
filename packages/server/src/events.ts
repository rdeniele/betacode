import type { AgentEvent } from "@betacode/shared";

export type ServerEvent =
  | { scope: "session"; sessionId: string; event: AgentEvent }
  | { scope: "terminal"; id: string; kind: "output" | "exit"; chunk?: string; code?: number | null }
  | { scope: "setup"; kind: "progress"; tag: string; status: string; completed?: number; total?: number }
  | { scope: "setup"; kind: "done" | "cancelled"; tag: string }
  | { scope: "setup"; kind: "error"; tag: string; message: string }
  | { scope: "app"; kind: "project.opened" | "sessions.changed" | "config.changed" };

export type ServerListener = (e: ServerEvent) => void;

/** Tiny pub/sub used to fan events out to SSE clients, the CLI renderer and tests. */
export class EventBus {
  private readonly listeners = new Set<ServerListener>();
  subscribe(l: ServerListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: ServerEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch {
        /* one bad listener must not break the others */
      }
    }
  }
}
