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

/** Build a provider from configuration. New providers are added here without touching the agent. */
export function createProvider(cfg: ProviderConfig): AIProvider {
  const common = { baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey || undefined };
  switch (cfg.provider) {
    case "qwen":
      return new QwenProvider(common);
    case "openrouter":
      return new OpenAICompatibleProvider({
        ...common,
        id: "openrouter",
        name: "OpenRouter",
        sendSamplingExtras: true,
        headers: { "X-Title": "BetaCode" },
      });
    case "openai":
      // The official OpenAI API rejects unknown sampling fields.
      return new OpenAICompatibleProvider({ ...common, id: "openai", name: "OpenAI", sendSamplingExtras: false });
    default:
      return new OpenAICompatibleProvider({ ...common, id: cfg.provider, name: cfg.provider });
  }
}
