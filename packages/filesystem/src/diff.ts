import { createTwoFilesPatch, structuredPatch } from "diff";

/** Unified diff for display. `before`/`after` of `null` mean the file does not exist on that side. */
export function unifiedDiff(path: string, before: string | null, after: string | null): string {
  const patch = createTwoFilesPatch(
    before === null ? "/dev/null" : `a/${path}`,
    after === null ? "/dev/null" : `b/${path}`,
    before ?? "",
    after ?? "",
    "",
    "",
    { context: 3 },
  );
  // Drop the "Index:" / "====" header lines produced by jsdiff.
  return patch.split("\n").slice(2).join("\n");
}

export function countChanges(before: string | null, after: string | null): { additions: number; deletions: number } {
  const p = structuredPatch("a", "b", before ?? "", after ?? "", "", "", { context: 0 });
  let additions = 0;
  let deletions = 0;
  for (const h of p.hunks) {
    for (const line of h.lines) {
      if (line.startsWith("+")) additions++;
      else if (line.startsWith("-")) deletions++;
    }
  }
  return { additions, deletions };
}
