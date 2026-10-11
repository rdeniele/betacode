# Providers

```ts
interface AIProvider { id; name; chat(req); stream(req): AsyncIterable<StreamEvent>; supportsTools(); getModels(); }
```

- `OpenAICompatibleProvider`: `POST {baseUrl}/chat/completions`, SSE streaming, tool calls assembled across chunks, retry on 429/5xx/connection errors before streaming starts, abort support, `GET /models` (reads `max_model_len` when present).
- `QwenProvider`: same, with Qwen3-Coder sampling defaults and a fallback that converts `<tool_call>` text (Qwen XML or Hermes JSON) into structured calls for runtimes without a tool-call parser. Tags are hidden from streamed text.
- `createProvider` (`factory.ts`) maps config to a provider: `qwen`, `openai-compatible`, `openrouter`, `openai`.

Anthropic and Gemini are available through their OpenAI-compatible endpoints; native APIs are not implemented. To add a provider, implement `AIProvider` and register it in the factory. The agent does not change.

`top_k` and `repetition_penalty` are sent to local servers; the `openai` provider omits them.
