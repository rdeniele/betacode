import { OpenAICompatibleProvider } from "./openai-compatible";
import type { AIProvider } from "./provider";
import { QwenProvider } from "./qwen";

export type ProviderKind = "qwen" | "openai-compatible" | "ollama" | "lmstudio" | "openai" | "openrouter";

export interface ProviderConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
}

/** True for loopback and private-network endpoints, i.e. a server the user runs themselves. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.toLowerCase();
    if (h === "localhost" || h === "::1" || h === "[::1]" || h.endsWith(".local")) return true;
    const m = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(h);
    if (!m) return false;
    const a = Number(m[1]);
    const b = Number(m[2]);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  } catch {
    return false;
  }
}

/**
 * Build a provider from configuration. New providers are added here without touching the agent.
 * `top_k` and `repetition_penalty` are extensions understood by local servers (vLLM, Ollama, llama.cpp);
 * hosted APIs may reject unknown fields, so they are only sent to local endpoints (and OpenRouter, which accepts them).
 */
export function createProvider(cfg: ProviderConfig): AIProvider {
  const common = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey || undefined };
  const local = isLocalUrl(cfg.baseUrl);
  switch (cfg.provider) {
    case "qwen":
      return new QwenProvider({ ...common, sendSamplingExtras: local });
    case "openrouter":
      return new OpenAICompatibleProvider({
        ...common,
        id: "openrouter",
        name: "OpenRouter",
        sendSamplingExtras: true,
        headers: { "X-Title": "BetaCode" },
      });
    case "openai":
      return new OpenAICompatibleProvider({ ...common, id: "openai", name: "OpenAI", sendSamplingExtras: false });
    default:
      return new OpenAICompatibleProvider({ ...common, id: cfg.provider, name: cfg.provider, sendSamplingExtras: local });
  }
}
