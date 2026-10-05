import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_IGNORES } from "@betacode/filesystem";

export const INSTRUCTION_FILE = "BETACODE.md";
const MAX_FILE_CHARS = 8000;
const MAX_TOTAL_CHARS = 20000;

export interface InstructionFile {
  path: string;
  /** Path relative to the project root ("." for the root file, "../x" for parents). */
  label: string;
  content: string;
  source: "root" | "parent" | "subdirectory" | "user";
}

function read(file: string): string | undefined {
  try {
    return readFileSync(file, "utf8").slice(0, MAX_FILE_CHARS);
  } catch {
    return undefined;
  }
}

/**
 * Find BETACODE.md files: user-level (~/.betacode), parent directories (up to the git root or 3 levels),
 * the project root, and subdirectories (depth ≤ 3, ignoring dependency/build folders).
 */
export function findInstructions(root: string, opts: { home?: string; maxParents?: number } = {}): InstructionFile[] {
  const out: InstructionFile[] = [];
  const rootAbs = resolve(root);

  if (opts.home) {
    const p = join(opts.home, ".betacode", INSTRUCTION_FILE);
    const c = existsSync(p) ? read(p) : undefined;
    if (c !== undefined) out.push({ path: p, label: "~/.betacode/BETACODE.md", content: c, source: "user" });
  }

  // Parents: stop at a repository root or after maxParents levels.
  const parents: string[] = [];
  let dir = rootAbs;
  for (let i = 0; i < (opts.maxParents ?? 3); i++) {
    if (existsSync(join(dir, ".git")) && dir !== rootAbs) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
    parents.push(dir);
    if (existsSync(join(dir, ".git"))) break;
  }
  for (const p of parents.reverse()) {
    const file = join(p, INSTRUCTION_FILE);
    const c = existsSync(file) ? read(file) : undefined;
    if (c !== undefined) out.push({ path: file, label: relative(rootAbs, file).split(sep).join("/"), content: c, source: "parent" });
  }

  const rootFile = join(rootAbs, INSTRUCTION_FILE);
  const rc = existsSync(rootFile) ? read(rootFile) : undefined;
  if (rc !== undefined) out.push({ path: rootFile, label: INSTRUCTION_FILE, content: rc, source: "root" });

  const ignored = new Set(DEFAULT_IGNORES);
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || ignored.has(e.name) || e.name.startsWith(".")) continue;
      const sub = join(d, e.name);
      const file = join(sub, INSTRUCTION_FILE);
      const c = existsSync(file) ? read(file) : undefined;
      if (c !== undefined) out.push({ path: file, label: relative(rootAbs, file).split(sep).join("/"), content: c, source: "subdirectory" });
      walk(sub, depth + 1);
    }
  };
  walk(rootAbs, 1);
  return out;
}

/** Combine instruction files into a single labelled block for the system prompt. */
export function formatInstructions(files: InstructionFile[]): string {
  let total = 0;
  const parts: string[] = [];
  for (const f of files) {
    const body = f.content.trim();
    if (!body) continue;
    if (total + body.length > MAX_TOTAL_CHARS) break;
    total += body.length;
    parts.push(`<!-- ${f.label} -->\n${body}`);
  }
  return parts.join("\n\n");
}
