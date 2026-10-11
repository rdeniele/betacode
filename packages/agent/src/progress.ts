import { createHash } from "node:crypto";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}

/** Detect repeated observations, including short read/search cycles, without retaining file contents. */
export class ProgressMonitor {
  private observations: string[] = [];

  reset(): void {
    this.observations = [];
  }

  observe(name: string, args: string, result: string): boolean {
    let normalized = args;
    try { normalized = JSON.stringify(canonical(JSON.parse(args))); } catch { /* Invalid calls have their own limit. */ }
    const fingerprint = createHash("sha256").update(JSON.stringify([name, normalized, result])).digest("hex");
    this.observations.push(fingerprint);
    this.observations = this.observations.slice(-12);
    for (let size = 1; size <= 4; size++) {
      if (this.observations.length < size * 3) continue;
      const tail = this.observations.slice(-size * 3);
      if (tail.every((item, index) => item === tail[index % size])) return true;
    }
    return false;
  }
}
