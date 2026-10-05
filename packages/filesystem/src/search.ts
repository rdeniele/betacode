import { spawn, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { BetaCodeError } from "@betacode/shared";
import type { FileService } from "./files";
import { DEFAULT_IGNORES } from "./ignore";
import { isSensitivePath } from "./workspace";

export interface SearchOptions {
  query: string;
  /** Directory or file (workspace-relative) to search in. */
  path?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  /** Glob filter on file paths, e.g. "*.ts". */
  glob?: string;
  context?: number;
  maxResults?: number;
  /** Force the built-in JS searcher (used in tests and when rg is missing). */
  useRipgrep?: boolean;
  signal?: AbortSignal;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
  /** Context lines (only when `context` > 0), each as `{line, text}`. */
  before?: Array<{ line: number; text: string }>;
  after?: Array<{ line: number; text: string }>;
}

let rgAvailable: boolean | undefined;
export function hasRipgrep(): boolean {
  if (rgAvailable === undefined) {
    try {
      rgAvailable = spawnSync("rg", ["--version"], { stdio: "ignore" }).status === 0;
    } catch {
      rgAvailable = false;
    }
  }
  return rgAvailable;
}

export async function searchText(fs: FileService, opts: SearchOptions): Promise<{ matches: SearchMatch[]; truncated: boolean; engine: "ripgrep" | "builtin" }> {
  if (!opts.query) throw new BetaCodeError("query must not be empty", "INVALID");
  const max = opts.maxResults ?? 200;
  const abs = fs.ws.resolve(opts.path ?? ".");
  const useRg = opts.useRipgrep ?? hasRipgrep();
  if (opts.regex) {
    try {
      new RegExp(opts.query);
    } catch (e) {
      throw new BetaCodeError(`Invalid regular expression: ${(e as Error).message}`, "INVALID");
    }
  }
  if (useRg) {
    const r = await rgSearch(fs, abs, opts, max);
    return { ...r, engine: "ripgrep" };
  }
  return { ...builtinSearch(fs, abs, opts, max), engine: "builtin" };
}

function rgSearch(fs: FileService, abs: string, opts: SearchOptions, max: number): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const args = ["--json", "--no-config", "--no-require-git", "--max-columns", "300", "--max-columns-preview"];
    if (!opts.regex) args.push("--fixed-strings");
    args.push(opts.caseSensitive ? "--case-sensitive" : "--smart-case");
    if (opts.context) args.push("-C", String(opts.context));
    for (const g of [...DEFAULT_IGNORES, ".env", ".env.*", "*.pem", "id_rsa*"]) args.push("--glob", "!" + g);
    // User globs are applied in JS: rg treats positive --glob as an override of ignore rules.
    const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;
    args.push("-e", opts.query, "--", abs);
    const child = spawn("rg", args, { cwd: fs.ws.root, stdio: ["ignore", "pipe", "pipe"] });
    const matches: SearchMatch[] = [];
    const pendingBefore = new Map<string, Array<{ line: number; text: string }>>();
    let buf = "";
    let truncated = false;
    let stderr = "";
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const handle = (line: string) => {
      if (!line) return;
      let ev: any;
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      const path = ev.data?.path?.text as string | undefined;
      if (!path) return;
      const rel = fs.ws.rel(path.startsWith("/") || /^[A-Za-z]:/.test(path) ? path : fs.ws.resolve(path));
      if (globRe && !globRe.test(rel) && !globRe.test(rel.split("/").pop()!)) return;
      const text = String(ev.data.lines?.text ?? "").replace(/\r?\n$/, "");
      const lineNo = ev.data.line_number as number;
      if (ev.type === "context") {
        const last = matches[matches.length - 1];
        if (last && last.path === rel && lineNo > last.line && lineNo - last.line <= (opts.context ?? 0)) {
          (last.after ??= []).push({ line: lineNo, text });
        } else {
          const arr = pendingBefore.get(rel) ?? [];
          arr.push({ line: lineNo, text });
          pendingBefore.set(rel, arr.slice(-(opts.context ?? 0)));
        }
      } else if (ev.type === "match") {
        if (matches.length >= max) {
          truncated = true;
          child.kill();
          return;
        }
        const m: SearchMatch = { path: rel, line: lineNo, text };
        const before = pendingBefore.get(rel)?.filter((b) => b.line < lineNo && lineNo - b.line <= (opts.context ?? 0));
        if (before?.length) m.before = before;
        pendingBefore.delete(rel);
        matches.push(m);
      }
    };
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        handle(buf.slice(0, i));
        buf = buf.slice(i + 1);
      }
    });
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      handle(buf);
      if (code === 2 && !truncated && stderr && matches.length === 0) reject(new BetaCodeError(`ripgrep error: ${stderr.trim().slice(0, 300)}`, "SEARCH_FAILED"));
      else resolve({ matches, truncated });
    });
  });
}

function builtinSearch(fs: FileService, abs: string, opts: SearchOptions, max: number): { matches: SearchMatch[]; truncated: boolean } {
  const flags = opts.caseSensitive ? "" : /[A-Z]/.test(opts.query) && !opts.regex ? "" : "i";
  const re = opts.regex ? new RegExp(opts.query, flags) : new RegExp(escapeRegExp(opts.query), flags);
  const globRe = opts.glob ? globToRegExp(opts.glob) : undefined;
  const matches: SearchMatch[] = [];
  const files = statSync(abs).isFile() ? [abs] : fs.walkFiles(abs);
  for (const file of files) {
    const rel = fs.ws.rel(file);
    if (isSensitivePath(rel)) continue;
    if (globRe && !globRe.test(rel) && !globRe.test(rel.split("/").pop()!)) continue;
    let content: string;
    try {
      if (statSync(file).size > 1_000_000) continue;
      const buf = readFileSync(file);
      if (buf.subarray(0, 8000).includes(0)) continue;
      content = buf.toString("utf8");
    } catch {
      continue;
    }
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!re.test(lines[i]!)) continue;
      if (matches.length >= max) return { matches, truncated: true };
      const m: SearchMatch = { path: rel, line: i + 1, text: lines[i]!.slice(0, 300) };
      const c = opts.context ?? 0;
      if (c > 0) {
        m.before = lines.slice(Math.max(0, i - c), i).map((t, k) => ({ line: Math.max(0, i - c) + k + 1, text: t }));
        m.after = lines.slice(i + 1, i + 1 + c).map((t, k) => ({ line: i + 2 + k, text: t }));
      }
      matches.push(m);
    }
  }
  return { matches, truncated: false };
}

export function findFiles(fs: FileService, pattern: string, opts: { path?: string; maxResults?: number } = {}): { files: string[]; truncated: boolean } {
  if (!pattern) throw new BetaCodeError("pattern must not be empty", "INVALID");
  const max = opts.maxResults ?? 200;
  const abs = fs.ws.resolve(opts.path ?? ".");
  const hasSlash = pattern.includes("/");
  const re = globToRegExp(pattern);
  const plain = !/[*?{]/.test(pattern) ? pattern.toLowerCase() : undefined;
  const files: string[] = [];
  for (const f of fs.walkFiles(abs)) {
    const rel = fs.ws.rel(f);
    const target = hasSlash ? rel : rel.split("/").pop()!;
    const hit = plain ? rel.toLowerCase().includes(plain) : re.test(target) || re.test(rel);
    if (hit) {
      if (files.length >= max) return { files, truncated: true };
      files.push(rel);
    }
  }
  return { files: files.sort(), truncated: false };
}

export function formatMatches(matches: SearchMatch[]): string {
  const out: string[] = [];
  for (const m of matches) {
    for (const b of m.before ?? []) out.push(`${m.path}-${b.line}-${b.text}`);
    out.push(`${m.path}:${m.line}:${m.text}`);
    for (const a of m.after ?? []) out.push(`${m.path}-${a.line}-${a.text}`);
    if (m.before || m.after) out.push("--");
  }
  return out.join("\n");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Glob → RegExp supporting `**`, `*`, `?` and `{a,b}`. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
        if (glob[i + 1] === undefined) re = re.replace(/\(\?:\.\*\/\)\?$/, ".*");
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end === -1) re += "\\{";
      else {
        re += "(?:" + glob.slice(i + 1, end).split(",").map(escapeRegExp).join("|") + ")";
        i = end;
      }
    } else re += escapeRegExp(c);
  }
  return new RegExp(`^${re}$`, "i");
}
