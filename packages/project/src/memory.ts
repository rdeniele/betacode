import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Durable project facts the agent has learned (real commands, conventions, gotchas), kept in `.betacode/memory.md`. */
export const MEMORY_FILE = join(".betacode", "memory.md");
const MAX_ENTRIES = 60;
const MAX_NOTE = 300;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

export function readMemory(root: string): string[] {
  const file = join(root, MEMORY_FILE);
  if (!existsSync(file)) return [];
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .map((l) => l.replace(/^\s*[-*]\s+/, "").trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch {
    return [];
  }
}

export function formatMemory(entries: string[], maxChars = 3000): string {
  const lines: string[] = [];
  let total = 0;
  for (const e of entries) {
    if (total + e.length > maxChars) break;
    total += e.length;
    lines.push(`- ${e}`);
  }
  return lines.join("\n");
}

export interface RememberResult {
  added: boolean;
  reason?: "duplicate" | "empty";
  entries: number;
}

/** Append a note (de-duplicated, length-limited, oldest entries dropped past the cap). */
export function remember(root: string, note: string): RememberResult {
  const clean = note.replace(/\s+/g, " ").trim().slice(0, MAX_NOTE);
  const entries = readMemory(root);
  if (!clean) return { added: false, reason: "empty", entries: entries.length };
  if (entries.some((e) => norm(e) === norm(clean))) return { added: false, reason: "duplicate", entries: entries.length };
  const next = [...entries, clean].slice(-MAX_ENTRIES);
  const file = join(root, MEMORY_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `# BetaCode project memory\n\n${next.map((e) => `- ${e}`).join("\n")}\n`);
  return { added: true, entries: next.length };
}

export function forget(root: string, index: number): boolean {
  const entries = readMemory(root);
  if (index < 0 || index >= entries.length) return false;
  entries.splice(index, 1);
  const file = join(root, MEMORY_FILE);
  writeFileSync(file, `# BetaCode project memory\n\n${entries.map((e) => `- ${e}`).join("\n")}\n`);
  return true;
}
