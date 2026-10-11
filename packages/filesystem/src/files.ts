import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { BetaCodeError } from "@betacode/shared";
import { ChangeTracker } from "./changes";
import { unifiedDiff } from "./diff";
import { loadIgnore, type IgnoreMatcher } from "./ignore";
import { Workspace, isSensitivePath } from "./workspace";

const LANGUAGES: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescriptreact", ".js": "javascript", ".jsx": "javascriptreact", ".mjs": "javascript",
  ".cjs": "javascript", ".json": "json", ".md": "markdown", ".py": "python", ".rs": "rust", ".go": "go", ".java": "java",
  ".kt": "kotlin", ".cs": "csharp", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".php": "php", ".rb": "ruby",
  ".css": "css", ".scss": "scss", ".html": "html", ".vue": "vue", ".svelte": "svelte", ".yml": "yaml", ".yaml": "yaml",
  ".toml": "toml", ".sh": "shell", ".sql": "sql", ".prisma": "prisma", ".xml": "xml", ".swift": "swift", ".dart": "dart",
};

export function languageOf(path: string): string {
  return LANGUAGES[extname(path).toLowerCase()] ?? "plaintext";
}

export const MAX_READ_BYTES = 2 * 1024 * 1024;
export const DEFAULT_READ_LINES = 2000;

export interface ReadResult {
  path: string;
  /** Content with line numbers, ready to show the model. */
  numbered: string;
  /** Raw requested slice without line numbers. */
  text: string;
  totalLines: number;
  startLine: number;
  endLine: number;
  size: number;
  language: string;
  truncated: boolean;
}

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: DirEntry[];
  /** Set when the directory was not expanded (depth/entry limit). */
  truncated?: boolean;
}

export interface WriteResult {
  path: string;
  kind: "added" | "modified";
  diff: string;
  bytes: number;
}

export interface EditResult {
  path: string;
  replacements: number;
  diff: string;
  /** True when oldText only matched after ignoring indentation. */
  fuzzy?: boolean;
}

const indentOf = (s: string) => /^[ \t]*/.exec(s)![0];

/**
 * Find `oldText` ignoring leading/trailing whitespace on each line. Returns the file with the block replaced
 * (re-indented to the file's indentation), "ambiguous" if several blocks match, or undefined if none does.
 */
export function looseReplace(file: string, oldText: string, newText: string): string | "ambiguous" | undefined {
  const eol = file.includes("\r\n") ? "\r\n" : "\n";
  const fileLines = file.split(/\r?\n/);
  const want = oldText.split(/\r?\n/);
  while (want.length && want[want.length - 1]!.trim() === "") want.pop();
  while (want.length && want[0]!.trim() === "") want.shift();
  if (!want.length || want.every((l) => l.trim() === "")) return undefined;
  const norm = want.map((l) => l.trim());
  const hits: number[] = [];
  for (let i = 0; i + want.length <= fileLines.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (fileLines[i + j]!.trim() !== norm[j]) {
        ok = false;
        break;
      }
    }
    if (ok) hits.push(i);
  }
  if (hits.length === 0) return undefined;
  if (hits.length > 1) return "ambiguous";
  const start = hits[0]!;
  const fileIndent = indentOf(fileLines[start]!);
  const wantIndent = indentOf(want[0]!);
  const replacement = newText.split(/\r?\n/).map((l) => {
    if (l.trim() === "") return l;
    return l.startsWith(wantIndent) ? fileIndent + l.slice(wantIndent.length) : l;
  });
  const out = [...fileLines.slice(0, start), ...replacement, ...fileLines.slice(start + want.length)];
  return out.join(eol);
}

function isBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** File operations confined to a workspace, with every mutation recorded in the {@link ChangeTracker}. */
export class FileService {
  readonly ignore: IgnoreMatcher;
  /** What the agent last saw of each file; used to refuse edits based on stale or imagined content. */
  private readonly seen = new Map<string, { mtimeMs: number; size: number }>();

  constructor(
    readonly ws: Workspace,
    readonly changes: ChangeTracker,
    private readonly opts: { requireReadBeforeEdit?: boolean } = {},
  ) {
    this.ignore = loadIgnore(ws.root);
  }

  private stamp(abs: string): void {
    try {
      const st = statSync(abs);
      this.seen.set(abs, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      this.seen.delete(abs);
    }
  }

  /** Throws if the file exists but was never read in this session, or changed since it was read. */
  private assertFresh(abs: string, rel: string): void {
    if (!this.opts.requireReadBeforeEdit) return;
    const s = this.seen.get(abs);
    if (!s) throw new BetaCodeError(`You have not read ${rel} yet. Use read_file on it first, then base your edit on exactly what you read.`, "NOT_READ");
    const st = statSync(abs);
    if (st.mtimeMs !== s.mtimeMs || st.size !== s.size) {
      throw new BetaCodeError(`${rel} changed on disk since you read it. Re-read it with read_file before editing.`, "STALE");
    }
  }

  read(path: string, opts: { offset?: number; limit?: number; allowSensitive?: boolean } = {}): ReadResult {
    const abs = this.ws.resolve(path);
    const rel = this.ws.rel(abs);
    if (!opts.allowSensitive && isSensitivePath(rel)) {
      throw new BetaCodeError(`${rel} looks like a secrets/credentials file and is not read automatically. Ask the user for permission first.`, "SENSITIVE");
    }
    if (!existsSync(abs)) throw new BetaCodeError(`File not found: ${rel}`, "NOT_FOUND");
    const st = statSync(abs);
    if (st.isDirectory()) throw new BetaCodeError(`${rel} is a directory; use list_directory.`, "IS_DIRECTORY");
    if (st.size > MAX_READ_BYTES) throw new BetaCodeError(`${rel} is ${st.size} bytes, larger than the ${MAX_READ_BYTES} byte read limit. Use search_files to locate the relevant section.`, "TOO_LARGE");
    const buf = readFileSync(abs);
    if (isBinary(buf)) throw new BetaCodeError(`${rel} appears to be a binary file.`, "BINARY");
    this.stamp(abs);
    const lines = buf.toString("utf8").split(/\r?\n/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    const start = Math.max(1, opts.offset ?? 1);
    const limit = Math.max(1, opts.limit ?? DEFAULT_READ_LINES);
    const slice = lines.slice(start - 1, start - 1 + limit);
    const end = start - 1 + slice.length;
    const width = String(end).length;
    return {
      path: rel,
      numbered: slice.map((l, i) => `${String(start + i).padStart(width, " ")}\t${l}`).join("\n"),
      text: slice.join("\n"),
      totalLines: lines.length,
      startLine: start,
      endLine: end,
      size: st.size,
      language: languageOf(rel),
      truncated: end < lines.length,
    };
  }

  /** Raw text for UI/editor use (no sensitive-file gate: the user is the one asking). */
  readText(path: string): string {
    const abs = this.ws.resolve(path);
    const buf = readFileSync(abs);
    if (isBinary(buf)) throw new BetaCodeError("Binary file", "BINARY");
    return buf.toString("utf8");
  }

  exists(path: string): boolean {
    return existsSync(this.ws.resolve(path));
  }

  write(path: string, content: string): WriteResult {
    const abs = this.ws.resolve(path);
    const rel = this.ws.rel(abs);
    if (rel === ".") throw new BetaCodeError("Cannot write to the workspace root.", "INVALID");
    let before: string | null = null;
    if (existsSync(abs)) {
      if (statSync(abs).isDirectory()) throw new BetaCodeError(`${rel} is a directory.`, "IS_DIRECTORY");
      this.assertFresh(abs, rel);
      before = readFileSync(abs, "utf8");
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    this.stamp(abs);
    this.changes.record(rel, before, content);
    return { path: rel, kind: before === null ? "added" : "modified", diff: unifiedDiff(rel, before, content), bytes: Buffer.byteLength(content) };
  }

  /** Compute the result of an edit without touching disk (used for permission previews). */
  planEdit(path: string, oldText: string, newText: string, replaceAll = false): { rel: string; before: string; after: string; replacements: number; fuzzy?: boolean } {
    const abs = this.ws.resolve(path);
    const rel = this.ws.rel(abs);
    if (!existsSync(abs)) throw new BetaCodeError(`File not found: ${rel}. Use write_file to create it.`, "NOT_FOUND");
    if (oldText === "") throw new BetaCodeError("oldText must not be empty. Use write_file to create or replace a whole file.", "INVALID");
    this.assertFresh(abs, rel);
    const before = readFileSync(abs, "utf8");
    let search = oldText;
    let replacement = newText;
    if (!before.includes(search) && before.includes("\r\n")) {
      search = oldText.replace(/\r?\n/g, "\r\n");
      replacement = newText.replace(/\r?\n/g, "\r\n");
    }
    const count = before.split(search).length - 1;
    if (count === 0) {
      // Small models often get indentation slightly wrong. Accept a single unambiguous match that differs only in indentation.
      const loose = looseReplace(before, oldText, newText);
      if (loose === "ambiguous") {
        throw new BetaCodeError(`oldText matches several places in ${rel} when indentation is ignored. Include more surrounding lines to make it unique.`, "AMBIGUOUS");
      }
      if (loose !== undefined) return { rel, before, after: loose, replacements: 1, fuzzy: true };
      throw new BetaCodeError(`oldText was not found in ${rel}. The file may have changed; re-read it with read_file and copy the text exactly (including whitespace).`, "NO_MATCH");
    }
    if (count > 1 && !replaceAll) {
      throw new BetaCodeError(`oldText matches ${count} places in ${rel}. Include more surrounding lines to make it unique, or set replaceAll to true.`, "AMBIGUOUS");
    }
    const after = replaceAll ? before.split(search).join(replacement) : before.replace(search, () => replacement);
    return { rel, before, after, replacements: replaceAll ? count : 1 };
  }

  edit(path: string, oldText: string, newText: string, replaceAll = false): EditResult {
    const plan = this.planEdit(path, oldText, newText, replaceAll);
    const abs = this.ws.resolve(path);
    writeFileSync(abs, plan.after);
    this.stamp(abs);
    this.changes.record(plan.rel, plan.before, plan.after);
    return { path: plan.rel, replacements: plan.replacements, diff: unifiedDiff(plan.rel, plan.before, plan.after), fuzzy: plan.fuzzy };
  }

  delete(path: string, opts: { recursive?: boolean } = {}): { path: string; deleted: number } {
    const abs = this.ws.resolve(path);
    const rel = this.ws.rel(abs);
    if (rel === ".") throw new BetaCodeError("Refusing to delete the workspace root.", "INVALID");
    if (!existsSync(abs)) throw new BetaCodeError(`Not found: ${rel}`, "NOT_FOUND");
    if (statSync(abs).isDirectory()) {
      if (!opts.recursive) throw new BetaCodeError(`${rel} is a directory. Pass recursive: true to delete it.`, "IS_DIRECTORY");
      let n = 0;
      for (const f of this.walkFiles(abs, false)) {
        const r = this.ws.rel(f);
        this.changes.record(r, readFileSync(f, "utf8"), null);
        n++;
      }
      rmSync(abs, { recursive: true, force: true });
      return { path: rel, deleted: n };
    }
    const before = readFileSync(abs, "utf8");
    rmSync(abs);
    this.changes.record(rel, before, null);
    return { path: rel, deleted: 1 };
  }

  move(from: string, to: string): { from: string; to: string } {
    const a = this.ws.resolve(from);
    const b = this.ws.resolve(to);
    if (!existsSync(a)) throw new BetaCodeError(`Not found: ${this.ws.rel(a)}`, "NOT_FOUND");
    if (existsSync(b)) throw new BetaCodeError(`Destination already exists: ${this.ws.rel(b)}`, "EXISTS");
    if (statSync(a).isDirectory()) throw new BetaCodeError("Moving directories is not supported; move files individually.", "UNSUPPORTED");
    const content = readFileSync(a, "utf8");
    mkdirSync(dirname(b), { recursive: true });
    renameSync(a, b);
    this.changes.record(this.ws.rel(a), content, null);
    this.changes.record(this.ws.rel(b), null, content);
    return { from: this.ws.rel(a), to: this.ws.rel(b) };
  }

  copy(from: string, to: string): { from: string; to: string } {
    const a = this.ws.resolve(from);
    const b = this.ws.resolve(to);
    if (!existsSync(a)) throw new BetaCodeError(`Not found: ${this.ws.rel(a)}`, "NOT_FOUND");
    if (existsSync(b)) throw new BetaCodeError(`Destination already exists: ${this.ws.rel(b)}`, "EXISTS");
    if (statSync(a).isDirectory()) throw new BetaCodeError("Copying directories is not supported; copy files individually.", "UNSUPPORTED");
    mkdirSync(dirname(b), { recursive: true });
    copyFileSync(a, b);
    this.changes.record(this.ws.rel(b), null, readFileSync(b, "utf8"));
    return { from: this.ws.rel(a), to: this.ws.rel(b) };
  }

  mkdir(path: string): { path: string } {
    const abs = this.ws.resolve(path);
    mkdirSync(abs, { recursive: true });
    return { path: this.ws.rel(abs) };
  }

  /** Directory tree that respects ignore rules. */
  list(path = ".", opts: { depth?: number; maxEntries?: number; includeIgnored?: boolean } = {}): DirEntry {
    const abs = this.ws.resolve(path);
    if (!existsSync(abs)) throw new BetaCodeError(`Not found: ${this.ws.rel(abs)}`, "NOT_FOUND");
    if (!statSync(abs).isDirectory()) throw new BetaCodeError(`${this.ws.rel(abs)} is not a directory.`, "NOT_DIRECTORY");
    const budget = { left: opts.maxEntries ?? 500 };
    const node = this.listDir(abs, opts.depth ?? 2, budget, opts.includeIgnored ?? false);
    return node;
  }

  private listDir(abs: string, depth: number, budget: { left: number }, includeIgnored: boolean): DirEntry {
    const rel = this.ws.rel(abs);
    const node: DirEntry = { name: rel === "." ? "." : rel.split("/").pop()!, path: rel, type: "dir", children: [] };
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return node;
    }
    entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of entries) {
      const childAbs = join(abs, e.name);
      const childRel = this.ws.rel(childAbs);
      const isDir = e.isDirectory();
      if (!includeIgnored && this.ignore.ignores(childRel, isDir)) continue;
      if (budget.left <= 0) {
        node.truncated = true;
        break;
      }
      budget.left--;
      if (isDir) {
        if (depth > 1) node.children!.push(this.listDir(childAbs, depth - 1, budget, includeIgnored));
        else node.children!.push({ name: e.name, path: childRel, type: "dir", truncated: true });
      } else {
        let size: number | undefined;
        try {
          size = statSync(childAbs).size;
        } catch {
          /* ignore */
        }
        node.children!.push({ name: e.name, path: childRel, type: "file", size });
      }
    }
    return node;
  }

  /** Walk files (ignore-aware). Symlinked directories are not followed. */
  *walkFiles(start: string = this.ws.root, respectIgnore = true): Generator<string> {
    const stack = [start];
    while (stack.length) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const abs = join(dir, e.name);
        const rel = this.ws.rel(abs);
        if (e.isSymbolicLink()) continue;
        if (respectIgnore && this.ignore.ignores(rel, e.isDirectory())) continue;
        if (e.isDirectory()) stack.push(abs);
        else if (e.isFile()) yield abs;
      }
    }
  }
}

/** Render a tree as indented text for the model. */
export function renderTree(node: DirEntry, indent = ""): string {
  const lines: string[] = [];
  for (const c of node.children ?? []) {
    lines.push(`${indent}${c.name}${c.type === "dir" ? "/" : ""}${c.truncated && c.type === "dir" && !c.children ? " …" : ""}`);
    if (c.children?.length) lines.push(renderTree(c, indent + "  "));
  }
  if (node.truncated) lines.push(`${indent}… (more entries not shown)`);
  return lines.filter((l) => l !== "").join("\n");
}
