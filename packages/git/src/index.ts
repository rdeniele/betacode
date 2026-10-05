import { execFile } from "node:child_process";
import { BetaCodeError } from "@betacode/shared";

export interface GitFileStatus {
  path: string;
  /** Index (staged) status letter, " " if none. */
  index: string;
  /** Working-tree status letter, " " if none. */
  workingTree: string;
  origPath?: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: GitFileStatus[];
  modified: GitFileStatus[];
  untracked: string[];
  conflicted: GitFileStatus[];
  clean: boolean;
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
}

export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
}

export interface GitResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Thin wrapper over the installed git CLI. */
export class Git {
  constructor(
    readonly cwd: string,
    private readonly signal?: AbortSignal,
  ) {}

  run(args: string[], opts: { allowFail?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      execFile(
        "git",
        args,
        { cwd: this.cwd, maxBuffer: 20 * 1024 * 1024, signal: this.signal, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" } },
        (err, stdout, stderr) => {
          if (err) {
            const e = err as NodeJS.ErrnoException & { code?: number | string };
            if (e.code === "ENOENT") return reject(new BetaCodeError("git is not installed or not on PATH.", "GIT_MISSING"));
            if (e.name === "AbortError") return reject(e);
            const code = typeof e.code === "number" ? e.code : 1;
            if (opts.allowFail) return resolve({ stdout, stderr, code });
            return reject(new BetaCodeError(`git ${args[0]} failed: ${(stderr || stdout || e.message).trim()}`, "GIT_FAILED"));
          }
          resolve({ stdout, stderr, code: 0 });
        },
      );
    });
  }

  async isRepo(): Promise<boolean> {
    try {
      const r = await this.run(["rev-parse", "--is-inside-work-tree"], { allowFail: true });
      return r.code === 0 && r.stdout.trim() === "true";
    } catch {
      return false;
    }
  }

  async status(): Promise<GitStatus> {
    const { stdout } = await this.run(["status", "--porcelain=v1", "-b", "-z", "--untracked-files=all"]);
    return parseStatus(stdout);
  }

  /** Unified diff. `staged` shows the index vs HEAD; otherwise working tree vs index. */
  async diff(opts: { staged?: boolean; path?: string; stat?: boolean } = {}): Promise<string> {
    const args = ["diff", "--no-color"];
    if (opts.staged) args.push("--cached");
    if (opts.stat) args.push("--stat");
    if (opts.path) args.push("--", opts.path);
    return (await this.run(args)).stdout;
  }

  async log(limit = 20): Promise<GitCommit[]> {
    const r = await this.run(["log", `-n${Math.max(1, Math.min(limit, 200))}`, "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e"], { allowFail: true });
    if (r.code !== 0) return []; // no commits yet
    return r.stdout
      .split("\x1e")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((rec) => {
        const [hash = "", shortHash = "", author = "", date = "", subject = ""] = rec.split("\x1f");
        return { hash, shortHash, author, date, subject };
      });
  }

  async branches(): Promise<GitBranch[]> {
    const { stdout } = await this.run(["branch", "-a", "--no-color"]);
    return stdout
      .split("\n")
      .map((l) => l.trimEnd())
      .filter((l) => l && !l.includes(" -> "))
      .map((l) => {
        const current = l.startsWith("*");
        const name = l.replace(/^[*+]?\s+/, "").replace(/^\(HEAD detached at (.+)\)$/, "$1");
        return { name: name.replace(/^remotes\//, ""), current, remote: name.startsWith("remotes/") };
      });
  }

  async currentBranch(): Promise<string | null> {
    const r = await this.run(["branch", "--show-current"], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() || null : null;
  }

  async checkout(ref: string, opts: { create?: boolean } = {}): Promise<string> {
    assertRef(ref);
    const r = await this.run(opts.create ? ["checkout", "-b", ref] : ["checkout", ref]);
    return (r.stdout + r.stderr).trim();
  }

  async add(paths: string[]): Promise<void> {
    if (!paths.length) throw new BetaCodeError("No paths to add.", "INVALID");
    await this.run(["add", "--", ...paths]);
  }

  async commit(message: string): Promise<{ hash: string; summary: string }> {
    if (!message.trim()) throw new BetaCodeError("Commit message must not be empty.", "INVALID");
    const r = await this.run(["commit", "-m", message]);
    const hash = (await this.run(["rev-parse", "--short", "HEAD"])).stdout.trim();
    return { hash, summary: r.stdout.trim().split("\n")[0] ?? "" };
  }

  async push(opts: { remote?: string; branch?: string } = {}): Promise<string> {
    const args = ["push"];
    if (opts.remote) {
      assertRef(opts.remote);
      args.push(opts.remote);
      if (opts.branch) {
        assertRef(opts.branch);
        args.push(opts.branch);
      }
    }
    const r = await this.run(args);
    return (r.stdout + r.stderr).trim();
  }

  async pull(): Promise<string> {
    const r = await this.run(["pull", "--ff-only"]);
    return (r.stdout + r.stderr).trim();
  }
}

/** Refuse refs that could be parsed as options. */
function assertRef(ref: string): void {
  if (!ref || ref.startsWith("-") || /[\s\0~^:?*\[\\]/.test(ref)) throw new BetaCodeError(`Invalid git ref: ${ref}`, "INVALID");
}

export function parseStatus(raw: string): GitStatus {
  const parts = raw.split("\0").filter((p) => p.length);
  const status: GitStatus = { branch: null, upstream: null, ahead: 0, behind: 0, staged: [], modified: [], untracked: [], conflicted: [], clean: true };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith("## ")) {
      const head = p.slice(3);
      const m = /^(?:No commits yet on |Initial commit on )?(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
      if (m) {
        status.branch = m[1]!.startsWith("HEAD (no branch)") ? null : m[1]!;
        status.upstream = m[2] ?? null;
        const a = /ahead (\d+)/.exec(m[3] ?? "");
        const b = /behind (\d+)/.exec(m[3] ?? "");
        status.ahead = a ? Number(a[1]) : 0;
        status.behind = b ? Number(b[1]) : 0;
      }
      continue;
    }
    const x = p[0]!;
    const y = p[1]!;
    const path = p.slice(3);
    if (x === "?" && y === "?") {
      status.untracked.push(path);
      continue;
    }
    const entry: GitFileStatus = { path, index: x, workingTree: y };
    if (x === "R" || x === "C") entry.origPath = parts[++i];
    if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) status.conflicted.push(entry);
    else {
      if (x !== " ") status.staged.push(entry);
      if (y !== " ") status.modified.push(entry);
    }
  }
  status.clean = !status.staged.length && !status.modified.length && !status.untracked.length && !status.conflicted.length;
  return status;
}

export function formatStatus(s: GitStatus): string {
  const lines = [`On branch ${s.branch ?? "(detached HEAD)"}${s.upstream ? ` (tracking ${s.upstream}, ahead ${s.ahead}, behind ${s.behind})` : ""}`];
  if (s.clean) lines.push("Working tree clean.");
  if (s.staged.length) lines.push("Staged:", ...s.staged.map((f) => `  ${f.index} ${f.path}`));
  if (s.modified.length) lines.push("Modified (unstaged):", ...s.modified.map((f) => `  ${f.workingTree} ${f.path}`));
  if (s.untracked.length) lines.push("Untracked:", ...s.untracked.map((f) => `  ? ${f}`));
  if (s.conflicted.length) lines.push("Conflicts:", ...s.conflicted.map((f) => `  U ${f.path}`));
  return lines.join("\n");
}
