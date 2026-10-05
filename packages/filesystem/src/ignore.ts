import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ignore, { type Ignore } from "ignore";

export const DEFAULT_IGNORES = [
  ".git",
  "node_modules",
  ".next",
  ".nuxt",
  ".svelte-kit",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".turbo",
  ".cache",
  "coverage",
  ".betacode",
  ".DS_Store",
];

export interface IgnoreMatcher {
  /** `rel` is a workspace-relative posix path. */
  ignores(rel: string, isDir: boolean): boolean;
}

/** Combines built-in ignores, the root `.gitignore`, and `.betacodeignore`. */
export function loadIgnore(root: string, extra: string[] = []): IgnoreMatcher {
  const ig: Ignore = ignore().add(DEFAULT_IGNORES).add(extra);
  for (const f of [".gitignore", ".betacodeignore"]) {
    const p = join(root, f);
    if (existsSync(p)) {
      try {
        ig.add(readFileSync(p, "utf8"));
      } catch {
        /* unreadable ignore file: fall back to defaults */
      }
    }
  }
  return {
    ignores(rel, isDir) {
      if (!rel || rel === ".") return false;
      return ig.ignores(isDir ? rel + "/" : rel);
    },
  };
}
