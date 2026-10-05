import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { BetaCodeError, z } from "@betacode/shared";

export const DEFAULT_MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
export const DEFAULT_BASE_URL = "http://localhost:8000/v1";

export const CONTEXT_PRESETS = [8192, 16384, 32768, 65536, 131072, 262144] as const;

const permissionValue = z.enum(["safe", "confirm", "dangerous", "deny"]);

export const ConfigSchema = z.object({
  /** "qwen" (default), "openai-compatible", "openrouter", "openai", … */
  provider: z.string().min(1).default("qwen"),
  model: z.string().min(1).default(DEFAULT_MODEL),
  baseUrl: z.string().url().default(DEFAULT_BASE_URL),
  /** Optional. Prefer BETA_CODE_API_KEY; this is never written to disk by default. */
  apiKey: z.string().optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).default(0.8),
  topK: z.number().int().min(0).default(20),
  repetitionPenalty: z.number().min(0.5).max(2).default(1.05),
  /** Context window to budget for. Never assume the model's full native window is available. */
  contextLength: z.number().int().min(2048).default(32768),
  maxOutputTokens: z.number().int().min(64).optional(),
  autoCompact: z.boolean().default(true),
  maxIterations: z.number().int().min(1).max(500).default(30),
  maxRetries: z.number().int().min(0).max(50).default(5),
  commandTimeoutMs: z.number().int().min(1000).default(120_000),
  /** Per-tool overrides: tool name → permission level, or "deny" to block entirely. */
  permissions: z.record(z.string(), permissionValue).default({}),
  /** Optional pricing per million tokens; cost is only shown when configured. */
  pricing: z.object({ inputPerMillion: z.number().min(0), outputPerMillion: z.number().min(0) }).optional(),
});

export type BetaCodeConfig = z.infer<typeof ConfigSchema>;
export type ConfigInput = z.input<typeof ConfigSchema>;

export function globalDir(home = homedir()): string {
  return join(home, ".betacode");
}

export interface LoadOptions {
  projectRoot?: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}

function readJson(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch (e) {
    throw new BetaCodeError(`Invalid JSON in ${file}: ${(e as Error).message}`, "CONFIG_INVALID");
  }
}

function fromEnv(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const str = (k: string, name: string) => {
    if (env[k]) out[name] = env[k];
  };
  const num = (k: string, name: string) => {
    if (env[k] !== undefined && env[k] !== "") out[name] = Number(env[k]);
  };
  str("BETA_CODE_PROVIDER", "provider");
  str("BETA_CODE_BASE_URL", "baseUrl");
  str("BETA_CODE_API_KEY", "apiKey");
  str("BETA_CODE_MODEL", "model");
  num("BETA_CODE_TEMPERATURE", "temperature");
  num("BETA_CODE_TOP_P", "topP");
  num("BETA_CODE_TOP_K", "topK");
  num("BETA_CODE_REPETITION_PENALTY", "repetitionPenalty");
  num("BETA_CODE_CONTEXT_LENGTH", "contextLength");
  num("BETA_CODE_MAX_ITERATIONS", "maxIterations");
  return out;
}

/** Defaults < ~/.betacode/config.json < ./.betacode/config.json < environment. */
export function loadConfig(opts: LoadOptions = {}): BetaCodeConfig {
  const home = opts.home ?? homedir();
  const layers = [readJson(join(globalDir(home), "config.json"))];
  if (opts.projectRoot) layers.push(readJson(join(opts.projectRoot, ".betacode", "config.json")));
  layers.push(fromEnv(opts.env ?? process.env));
  const merged: Record<string, unknown> = {};
  for (const layer of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (k === "permissions" && v && typeof v === "object") merged.permissions = { ...(merged.permissions as object), ...(v as object) };
      else merged[k] = v;
    }
  }
  const parsed = ConfigSchema.safeParse(merged);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
    throw new BetaCodeError(`Invalid BetaCode configuration: ${msg}`, "CONFIG_INVALID");
  }
  return parsed.data;
}

export interface SaveOptions {
  scope: "global" | "project";
  projectRoot?: string;
  home?: string;
  /** Opt in to writing the API key in plaintext. Off by default. */
  persistApiKeyInsecurely?: boolean;
}

/** Merge `patch` into the config file for the scope. API keys are dropped unless explicitly allowed. */
export function saveConfig(patch: Partial<ConfigInput>, opts: SaveOptions): string {
  const file = opts.scope === "global" ? join(globalDir(opts.home), "config.json") : join(opts.projectRoot ?? "", ".betacode", "config.json");
  if (opts.scope === "project" && !opts.projectRoot) throw new BetaCodeError("projectRoot is required for project config.", "INVALID");
  const current = readJson(file);
  const next: Record<string, unknown> = { ...current, ...patch };
  if (!opts.persistApiKeyInsecurely) delete next.apiKey;
  const parsed = ConfigSchema.safeParse(next);
  if (!parsed.success) {
    throw new BetaCodeError(`Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, "CONFIG_INVALID");
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
  return file;
}
