import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir, platform } from "node:os";
import { isAbsolute, join } from "node:path";
import { BetaCodeError } from "@betacode/shared";

export const OLLAMA_ORIGIN = "http://localhost:11434";

export interface OllamaStatus {
  installed: boolean;
  exe?: string;
  running: boolean;
  version?: string;
  models: Array<{ name: string; sizeGB: number }>;
  /** Context window of the model currently loaded, if any. */
  loadedContext?: number;
}

export function findOllamaExe(): string | undefined {
  const os = platform();
  const finder = os === "win32" ? ["where", ["ollama"]] : ["which", ["ollama"]];
  try {
    const r = spawnSync(finder[0] as string, finder[1] as string[], { encoding: "utf8", windowsHide: true, timeout: 4000 });
    const first = r.status === 0 ? r.stdout.split(/\r?\n/).find(Boolean) : undefined;
    if (first && existsSync(first)) return first;
  } catch {
    /* fall through */
  }
  const candidates =
    os === "win32"
      ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "Ollama", "ollama.exe")]
      : os === "darwin"
        ? ["/usr/local/bin/ollama", "/opt/homebrew/bin/ollama", "/Applications/Ollama.app/Contents/Resources/ollama"]
        : ["/usr/local/bin/ollama", "/usr/bin/ollama"];
  return candidates.find((c) => existsSync(c));
}

async function getJson<T>(url: string, timeoutMs = 2500): Promise<T | undefined> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok ? ((await r.json()) as T) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(t);
  }
}

export async function ollamaStatus(origin = OLLAMA_ORIGIN, exe = findOllamaExe()): Promise<OllamaStatus> {
  const v = await getJson<{ version?: string }>(`${origin}/api/version`);
  if (!v) return { installed: !!exe, exe, running: false, models: [] };
  const tags = await getJson<{ models?: Array<{ name: string; size?: number }> }>(`${origin}/api/tags`);
  const ps = await getJson<{ models?: Array<{ context_length?: number }> }>(`${origin}/api/ps`);
  return {
    installed: true,
    exe,
    running: true,
    version: v.version,
    models: (tags?.models ?? []).map((m) => ({ name: m.name, sizeGB: Math.round(((m.size ?? 0) / 1024 ** 3) * 10) / 10 })),
    loadedContext: ps?.models?.map((m) => m.context_length).find((n): n is number => typeof n === "number"),
  };
}

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
}

/** Download a model through Ollama's own API (it decides where files go: OLLAMA_MODELS). Resolves when finished. */
export async function pullModel(tag: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal, origin = OLLAMA_ORIGIN): Promise<void> {
  if (!/^[\w.\-:/]+$/.test(tag)) throw new BetaCodeError(`Invalid model name: ${tag}`, "INVALID");
  let res: Response;
  try {
    res = await fetch(`${origin}/api/pull`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: tag, stream: true }), signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new BetaCodeError("Cannot reach Ollama. Start it first, then try again.", "OLLAMA_DOWN");
  }
  if (!res.ok || !res.body) throw new BetaCodeError(`Ollama refused the download (HTTP ${res.status}).`, "PULL_FAILED");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let ev: { status?: string; error?: string; completed?: number; total?: number };
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.error) throw new BetaCodeError(`Download failed: ${ev.error}`, "PULL_FAILED");
      onProgress({ status: ev.status ?? "", completed: ev.completed, total: ev.total });
    }
  }
}

export interface EnvSettings {
  OLLAMA_CONTEXT_LENGTH: string;
  OLLAMA_FLASH_ATTENTION: string;
  OLLAMA_KV_CACHE_TYPE: string;
  OLLAMA_MODELS?: string;
}

export function recommendedEnv(contextLength: number, modelsDir?: string): EnvSettings {
  return {
    OLLAMA_CONTEXT_LENGTH: String(contextLength),
    OLLAMA_FLASH_ATTENTION: "1",
    OLLAMA_KV_CACHE_TYPE: "q8_0",
    ...(modelsDir ? { OLLAMA_MODELS: modelsDir } : {}),
  };
}

export type EnvWriter = (name: string, value: string) => boolean;

/** Persist a user-level environment variable (Windows `setx`). Injected in tests so they never touch the real environment. */
export const setxWriter: EnvWriter = (name, value) => {
  const r = spawnSync("setx", [name, value], { windowsHide: true, timeout: 8000 });
  return r.status === 0;
};

export interface ApplyResult {
  applied: string[];
  manual: string[];
}

/** Store the recommended Ollama settings. On non-Windows systems the commands are returned for the user to run. */
export function applyOllamaEnv(env: EnvSettings, writer: EnvWriter = setxWriter, os = platform()): ApplyResult {
  if (env.OLLAMA_MODELS) {
    if (!isAbsolute(env.OLLAMA_MODELS)) throw new BetaCodeError("The models folder must be an absolute path.", "INVALID");
    mkdirSync(env.OLLAMA_MODELS, { recursive: true });
  }
  const entries = Object.entries(env) as Array<[string, string]>;
  if (os !== "win32") {
    return { applied: [], manual: entries.map(([k, v]) => `export ${k}=${v}`) };
  }
  const applied: string[] = [];
  const manual: string[] = [];
  for (const [k, v] of entries) {
    if (writer(k, v)) applied.push(`${k}=${v}`);
    else manual.push(`setx ${k} "${v}"`);
  }
  return { applied, manual };
}

/** Restart the local Ollama server with the given environment so new settings take effect (user-initiated only). */
export async function restartOllama(env: EnvSettings, origin = OLLAMA_ORIGIN): Promise<OllamaStatus> {
  const exe = findOllamaExe();
  if (!exe) throw new BetaCodeError("Ollama is not installed.", "NOT_INSTALLED");
  if (platform() === "win32") {
    for (const image of ["ollama app.exe", "ollama.exe"]) spawnSync("taskkill", ["/IM", image, "/F"], { windowsHide: true, timeout: 8000 });
  } else {
    spawnSync("pkill", ["-x", "ollama"], { timeout: 8000 });
  }
  await new Promise((r) => setTimeout(r, 1500));
  const child = spawn(exe, ["serve"], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, ...env } });
  child.unref();
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const s = await ollamaStatus(origin, exe);
    if (s.running) return s;
  }
  throw new BetaCodeError("Ollama did not come back up within 15 seconds.", "RESTART_FAILED");
}
