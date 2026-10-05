import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { FileChangeInfo } from "@betacode/shared";
import { BetaCodeError } from "@betacode/shared";
import { countChanges, unifiedDiff } from "./diff";
import type { Workspace } from "./workspace";

export interface TrackedChange {
  id: string;
  path: string;
  /** Content before the first modification; null when the file did not exist. */
  before: string | null;
  /** Latest content written by the agent; null when deleted. */
  after: string | null;
  status: "pending" | "accepted" | "reverted";
  turn: number;
  updatedAt: number;
}

export type ChangeListener = (change: TrackedChange) => void;

/**
 * Records every modification the agent makes, with the original content, so each can be reviewed,
 * accepted or reverted from file snapshots (never via destructive git commands).
 */
export class ChangeTracker {
  private readonly changes = new Map<string, TrackedChange>(); // by path, one active change per path
  private readonly history: TrackedChange[] = [];
  private readonly redoStack: TrackedChange[] = [];
  turn = 0;

  constructor(
    private readonly ws: Workspace,
    private readonly onChange?: ChangeListener,
    initial: TrackedChange[] = [],
  ) {
    for (const c of initial) {
      this.history.push(c);
      if (c.status === "pending") this.changes.set(c.path, c);
    }
  }

  nextTurn(): number {
    return ++this.turn;
  }

  /** Record a write. Multiple writes to one file coalesce so `before` stays the original content. */
  record(path: string, before: string | null, after: string | null): TrackedChange | undefined {
    const existing = this.changes.get(path);
    if (existing && existing.status === "pending") {
      existing.after = after;
      existing.updatedAt = Date.now();
      existing.turn = this.turn;
      if (existing.before === existing.after) {
        // Net no-op: drop it.
        this.changes.delete(path);
        const i = this.history.indexOf(existing);
        if (i >= 0) this.history.splice(i, 1);
        existing.status = "reverted";
        this.onChange?.(existing);
        return undefined;
      }
      this.onChange?.(existing);
      return existing;
    }
    if (before === after) return undefined;
    const c: TrackedChange = { id: randomUUID(), path, before, after, status: "pending", turn: this.turn, updatedAt: Date.now() };
    this.changes.set(path, c);
    this.history.push(c);
    this.redoStack.length = 0;
    this.onChange?.(c);
    return c;
  }

  list(filter?: { status?: TrackedChange["status"] }): TrackedChange[] {
    return this.history.filter((c) => !filter?.status || c.status === filter.status);
  }

  get(id: string): TrackedChange | undefined {
    return this.history.find((c) => c.id === id);
  }

  toInfo(c: TrackedChange): FileChangeInfo {
    const { additions, deletions } = countChanges(c.before, c.after);
    return {
      id: c.id,
      path: c.path,
      kind: c.before === null ? "added" : c.after === null ? "deleted" : "modified",
      status: c.status,
      turn: c.turn,
      additions,
      deletions,
      diff: unifiedDiff(c.path, c.before, c.after),
    };
  }

  accept(id: string): TrackedChange {
    const c = this.mustGet(id);
    c.status = "accepted";
    this.changes.delete(c.path);
    this.onChange?.(c);
    return c;
  }

  /** Restore the original content. Refuses if the file was edited by someone else since, unless `force`. */
  revert(id: string, force = false): TrackedChange {
    const c = this.mustGet(id);
    if (c.status === "reverted") return c;
    const abs = this.ws.resolve(c.path);
    const current = existsSync(abs) ? readFileSync(abs, "utf8") : null;
    if (!force && current !== c.after) {
      throw new BetaCodeError(`${c.path} was modified after BetaCode changed it; refusing to overwrite. Revert with force to discard those edits.`, "CONFLICT");
    }
    if (c.before === null) {
      if (existsSync(abs)) rmSync(abs);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.before);
    }
    c.status = "reverted";
    this.changes.delete(c.path);
    this.redoStack.push(c);
    this.onChange?.(c);
    return c;
  }

  /** Revert the most recent pending change. */
  undo(): TrackedChange | undefined {
    const last = [...this.history].reverse().find((c) => c.status === "pending");
    return last ? this.revert(last.id) : undefined;
  }

  /** Re-apply the most recently reverted change. */
  redo(): TrackedChange | undefined {
    const c = this.redoStack.pop();
    if (!c) return undefined;
    const abs = this.ws.resolve(c.path);
    if (c.after === null) {
      if (existsSync(abs)) rmSync(abs);
    } else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, c.after);
    }
    c.status = "pending";
    c.updatedAt = Date.now();
    this.changes.set(c.path, c);
    this.onChange?.(c);
    return c;
  }

  private mustGet(id: string): TrackedChange {
    const c = this.get(id);
    if (!c) throw new BetaCodeError(`Unknown change ${id}`, "NOT_FOUND");
    return c;
  }
}
