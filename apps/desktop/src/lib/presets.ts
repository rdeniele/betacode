export interface ProviderPreset {
  id: string;
  label: string;
  provider: string;
  baseUrl: string;
  note?: string;
  needsKey: boolean;
  /** Where to create a key (you create it yourself; BetaCode never creates accounts). */
  keyUrl?: string;
}

export const QWEN_MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";

/** Provider choices shown in Settings. Anthropic and Gemini are reached through their OpenAI-compatible endpoints. */
export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "local", label: "Local (Qwen3-Coder)", provider: "qwen", baseUrl: "http://localhost:8000/v1", needsKey: false, note: "Any OpenAI-compatible local server: vLLM, Ollama, LM Studio, llama.cpp." },
  { id: "openai", label: "OpenAI", provider: "openai", baseUrl: "https://api.openai.com/v1", needsKey: true, keyUrl: "https://platform.openai.com/api-keys" },
  { id: "anthropic", label: "Anthropic", provider: "openai-compatible", baseUrl: "https://api.anthropic.com/v1", needsKey: true, keyUrl: "https://console.anthropic.com/settings/keys", note: "Uses Anthropic's OpenAI-compatible endpoint. The native Messages API is not implemented yet." },
  { id: "gemini", label: "Gemini", provider: "openai-compatible", baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai", needsKey: true, keyUrl: "https://aistudio.google.com/apikey", note: "Uses Google's OpenAI-compatible endpoint. The native Gemini API is not implemented yet." },
  { id: "openrouter", label: "OpenRouter", provider: "openrouter", baseUrl: "https://openrouter.ai/api/v1", needsKey: true, keyUrl: "https://openrouter.ai/keys", note: "Some models are offered with a free tier (names ending in :free); free usage is rate-limited." },
  { id: "groq", label: "Groq", provider: "openai-compatible", baseUrl: "https://api.groq.com/openai/v1", needsKey: true, keyUrl: "https://console.groq.com/keys", note: "Has a rate-limited free tier; check Groq's current terms." },
  { id: "huggingface", label: "Hugging Face", provider: "openai-compatible", baseUrl: "https://router.huggingface.co/v1", needsKey: true, keyUrl: "https://huggingface.co/settings/tokens", note: "Use a Hugging Face access token. Free usage is limited; check Hugging Face's current terms." },
  { id: "custom", label: "Custom OpenAI-compatible", provider: "openai-compatible", baseUrl: "", needsKey: false },
];

export function presetFor(provider: string, baseUrl: string): ProviderPreset {
  if (provider === "qwen") return PROVIDER_PRESETS[0]!;
  return PROVIDER_PRESETS.find((p) => p.id !== "custom" && p.provider === provider && p.baseUrl === baseUrl) ?? (provider === "openrouter" ? PROVIDER_PRESETS.find((p) => p.id === "openrouter")! : provider === "openai" ? PROVIDER_PRESETS.find((p) => p.id === "openai")! : PROVIDER_PRESETS.find((p) => p.id === "custom")!);
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
    steps: [
      "Downloads the model on pull (multiple GB). BetaCode never downloads models for you.",
      "Important: Ollama's default context window is only 4096 tokens, which silently cuts off BetaCode's instructions. Set a larger one, then restart Ollama. BetaCode warns you if it detects this.",
      "Small GPU (about 4 GB)? Use a small non-thinking model such as qwen3:4b-instruct and an 8192 context. Larger contexts and models that do not fit the GPU get much slower. Avoid thinking models: they spend hundreds of tokens reasoning before every answer.",
    ],
    commands: ["setx OLLAMA_CONTEXT_LENGTH 8192", "setx OLLAMA_FLASH_ATTENTION 1", "setx OLLAMA_KV_CACHE_TYPE q8_0", "ollama pull qwen3:4b-instruct", "ollama pull qwen3-coder:30b"],
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
