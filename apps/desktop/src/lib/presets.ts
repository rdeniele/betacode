export interface ProviderPreset {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  note?: string;
  needsKey: boolean;
}

export const QWEN_MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";

/** Provider choices shown in Settings. Anthropic and Gemini are reached through their OpenAI-compatible endpoints. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "local", label: "Local (Qwen3-Coder)", provider: "qwen", baseUrl: "http://localhost:8000/v1", needsKey: false, note: "Any OpenAI-compatible local server: vLLM, Ollama, LM Studio, llama.cpp." },
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", needsKey: true },
  { id: "anthropic", label: "Anthropic", provider: "openai-compatible", baseUrl: "https://api.anthropic.com/v1", needsKey: true, note: "Uses Anthropic's OpenAI-compatible endpoint. The native Messages API is not implemented yet." },
  { id: "gemini", label: "Gemini", provider: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, note: "Uses Google's OpenAI-compatible endpoint. The native Gemini API is not implemented yet." },
  { id: "openrouter", label: "OpenRouter", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true },
  { id: "custom", label: "Custom OpenAI-compatible", provider: "openai-compatible", baseUrl: "", needsKey: false },
];

export function presetFor(provider: string, baseUrl: string): ProviderPreset {
  if (provider === "qwen") return PROVIDER_PRESETS[0]!;
  return PROVIDER_PRESETS.find((p) => p.id !== "custom" && p.provider === provider && p.baseUrl === baseUrl) ?? (provider === "openrouter" ? PROVIDER_PRESETS[4]! : provider === "openai" ? PROVIDER_PRESETS[1]! : PROVIDER_PRESETS[5]!);
}

export const CONTEXT_OPTIONS = [8192, 16384, 32768, 65536, 131072, 262144];

export interface RuntimeGuide {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  steps: string[];
  commands: string[];
}

export const RUNTIMES: RuntimeGuide[] = [
  {
    id: "vllm",
    name: "vLLM",
    baseUrl: "http://localhost:8000/v1",
    model: QWEN_MODEL,
    steps: ["Needs a CUDA GPU with enough memory for the model (the 30B MoE model is large — consider a quantised build)."],
    commands: [`vllm serve ${QWEN_MODEL} --max-model-len 32768 --enable-auto-tool-choice --tool-call-parser qwen3_coder --port 8000`],
  },
  {
    id: "ollama",
    name: "Ollama",
    baseUrl: "http://localhost:11434/v1",
    model: "qwen3-coder:30b",
    steps: ["Downloads the model on `pull` (multiple GB). BetaCode never downloads models for you."],
    commands: ["ollama pull qwen3-coder:30b", "ollama serve"],
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    baseUrl: "http://localhost:1234/v1",
    model: "qwen3-coder-30b-a3b-instruct",
    steps: ["Download a Qwen3-Coder GGUF in LM Studio, load it, then start the local server from the Developer tab."],
    commands: [],
  },
  {
    id: "llamacpp",
    name: "llama.cpp",
    baseUrl: "http://localhost:8000/v1",
    model: QWEN_MODEL,
    steps: ["`--jinja` is required for tool calling."],
    commands: ["llama-server -hf Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M --jinja -c 32768 --port 8000"],
  },
];
