# Running a local model

BetaCode needs an OpenAI-compatible endpoint with tool calling. **No API key is required for local servers.** BetaCode never downloads model weights. They are open under the model's license, but you need suitable hardware.

Default: `Qwen/Qwen3-Coder-30B-A3B-Instruct` at `http://localhost:8000/v1`.

## vLLM

```bash
vllm serve Qwen/Qwen3-Coder-30B-A3B-Instruct --max-model-len 32768 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --port 8000
```

## Ollama

```bash
ollama pull qwen3-coder:30b
```

Set endpoint `http://localhost:11434/v1` and model `qwen3-coder:30b`.

## LM Studio

Load a Qwen3-Coder GGUF, start the local server, use `http://localhost:1234/v1`.

## llama.cpp

```bash
llama-server -hf Qwen/Qwen3-Coder-30B-A3B-Instruct-GGUF:Q4_K_M --jinja -c 32768 --port 8000
```

`--jinja` is required for tool calling.

## Hardware guide (measured on a laptop with 23 GB RAM and a 4 GB GPU)

| Setup | Result |
|---|---|
| `qwen3:8b` (thinking), 16K context | about 1.7 tokens/s; a 6-step task took more than 15 minutes |
| `qwen3:4b` (thinking), 8K context | about 6 tokens/s, but wastes hundreds of tokens thinking |
| `qwen3:4b-instruct` (non-thinking), 8K context, flash attention, q8 KV cache | fixed a real bug end to end (list, read, edit, run tests, report) in about 2 minutes |

Lessons: the model and its context memory should fit your GPU (VRAM). Anything that spills to the CPU is several times slower. Prefer non-thinking ("instruct") builds. A bigger context window costs speed, so use the smallest that fits (8K is workable; 16K or more if your hardware allows).

## Ollama: set the context window

Ollama's default context is 4096 tokens, which **silently truncates** BetaCode's prompt (instructions, tools, project tree) and makes any model look unintelligent. Set it and restart Ollama:

```bash
setx OLLAMA_CONTEXT_LENGTH 8192
setx OLLAMA_FLASH_ATTENTION 1
setx OLLAMA_KV_CACHE_TYPE q8_0
```

BetaCode warns in chat when it sees the server reading far fewer tokens than it sent, and `betacode doctor` checks the loaded context.

## Context

The model supports 262K tokens natively, but do not assume your machine can afford that. Choose 8K to 256K in Settings; BetaCode also lowers its budget to what the server reports (`max_model_len`).

## Troubleshooting

`pnpm cli doctor` (or Settings → Doctor) checks the endpoint and that the model name is listed. If the model prints `<tool_call>` text, BetaCode converts it; if it never calls tools, enable your runtime's tool-call parser.

## Hosted models with an API key (optional)

If your machine is too small, Settings → AI Models also works with hosted providers (OpenRouter, Groq, Hugging Face, Gemini, OpenAI, Anthropic, or any OpenAI-compatible URL). Some of them have rate-limited free tiers; check each provider's current terms. You create the account and key yourself (the settings page links to each provider's key page). Your prompts and code are sent to that provider.

Keys are tied to the provider's host, so a key for one provider is never sent to another. By default a key lives in memory until BetaCode closes. On Windows you can tick "Remember on this computer": the key is then stored encrypted with your Windows account (DPAPI) in `~/.betacode/secrets.json`, never as plain text. Elsewhere, set `BETA_CODE_API_KEY`. The environment variable always wins over a typed or saved key.
