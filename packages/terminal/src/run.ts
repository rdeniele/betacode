import { spawn, spawnSync } from "node:child_process";
import { BetaCodeError, filterEnv, isSecretKey } from "@betacode/shared";

export interface RunOptions {
  command: string;
  /** Absolute working directory (already validated against the workspace by the caller). */
  cwd: string;
  /** Milliseconds; the process tree is killed when it elapses. Default 120 s. */
  timeoutMs?: number;
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** Streaming callback for live output. */
  onOutput?: (chunk: string, stream: "stdout" | "stderr") => void;
  /** Pass the full parent environment (user-initiated commands). Agent commands always get a filtered env. */
  inheritEnv?: boolean;
  /** Max bytes retained per stream (head + tail are kept). Default 100 000. */
  maxOutputBytes?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

/** Env vars the model may not override: they change what gets executed or how. */
const BLOCKED_ENV = new Set(["PATH", "PATHEXT", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "NODE_OPTIONS", "COMSPEC", "SHELL", "HOME", "USERPROFILE", "PYTHONPATH", "PYTHONSTARTUP"]);

export function validateEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new BetaCodeError(`Invalid environment variable name: ${k}`, "INVALID_ENV");
    if (BLOCKED_ENV.has(k.toUpperCase())) throw new BetaCodeError(`Setting ${k} is not allowed.`, "INVALID_ENV");
    if (isSecretKey(k)) throw new BetaCodeError(`Setting secret-like variable ${k} is not allowed.`, "INVALID_ENV");
    out[k] = String(v);
  }
  return out;
}

class Capture {
  private head = "";
  private tail = "";
  private total = 0;
  truncated = false;
  constructor(private readonly max: number) {}
  push(s: string): void {
    this.total += s.length;
    const half = Math.floor(this.max / 2);
    if (!this.truncated && this.head.length + s.length <= this.max) {
      this.head += s;
      return;
    }
    if (!this.truncated) {
      this.truncated = true;
      const all = this.head + s;
      this.head = all.slice(0, half);
      this.tail = all.slice(half);
    } else {
      this.tail += s;
    }
    if (this.tail.length > half) this.tail = this.tail.slice(this.tail.length - half);
  }
  toString(): string {
    if (!this.truncated) return this.head;
    const omitted = this.total - this.head.length - this.tail.length;
    return `${this.head}\n… [${omitted} characters omitted] …\n${this.tail}`;
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/** Run a shell command, capturing output, honouring timeout and cancellation. Never throws for non-zero exit. */
export function runCommand(opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const max = opts.maxOutputBytes ?? 100_000;
  const out = new Capture(max);
  const err = new Capture(max);
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return new Promise<RunResult>((resolve) => {
    if (opts.signal?.aborted) {
      return resolve({ stdout: "", stderr: "", exitCode: null, signal: null, durationMs: 0, timedOut: false, cancelled: true, truncated: false });
    }
    const env = opts.inheritEnv ? ({ ...process.env, ...validateEnv(opts.env) } as Record<string, string>) : filterEnv(process.env, validateEnv(opts.env));
    const child = spawn(opts.command, {
      cwd: opts.cwd,
      env,
      shell: true,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const finish = (exitCode: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: out.toString(),
        stderr: err.toString(),
        exitCode,
        signal,
        durationMs: Date.now() - started,
        timedOut,
        cancelled,
        truncated: out.truncated || err.truncated,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    const onAbort = () => {
      cancelled = true;
      killTree(child.pid);
    };
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (d: string) => {
      out.push(d);
      opts.onOutput?.(d, "stdout");
    });
    child.stderr!.on("data", (d: string) => {
      err.push(d);
      opts.onOutput?.(d, "stderr");
    });
    child.on("error", (e) => {
      err.push(`Failed to start process: ${e.message}`);
      finish(null, null);
    });
    child.on("close", (code, sig) => finish(code, sig));
  });
}

/** Format a result as text for the model. */
export function formatRunResult(command: string, r: RunResult): string {
  const lines = [`$ ${command}`];
  if (r.cancelled) lines.push("[cancelled by user]");
  if (r.timedOut) lines.push("[timed out: the process was killed]");
  lines.push(`exit code: ${r.exitCode ?? "none"}${r.signal ? ` (signal ${r.signal})` : ""}  duration: ${r.durationMs}ms`);
  if (r.stdout.trim()) lines.push("--- stdout ---", r.stdout.trimEnd());
  if (r.stderr.trim()) lines.push("--- stderr ---", r.stderr.trimEnd());
  if (!r.stdout.trim() && !r.stderr.trim()) lines.push("(no output)");
  return lines.join("\n");
}

/** Heuristic: does this command look like it runs tests/validation? */
export function looksLikeTestCommand(command: string): boolean {
  return /\b(test|tests|vitest|jest|pytest|mocha|lint|typecheck|tsc|check|clippy|vet|build)\b/i.test(command);
}
