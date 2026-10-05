import { OpenAICompatibleProvider, type OpenAICompatibleOptions } from "./openai-compatible";
import type { ChatRequest, ChatResponse, StreamEvent } from "./provider";
import { TOOL_OPEN, ToolTagFilter, parseTextToolCalls } from "./text-tool-calls";

export const QWEN_DEFAULT_MODEL = "Qwen/Qwen3-Coder-30B-A3B-Instruct";
export const QWEN_DEFAULT_BASE_URL = "http://localhost:8000/v1";

/** Sampling defaults recommended by the Qwen3-Coder model card. All are configurable. */
export const QWEN_SAMPLING_DEFAULTS = {
  temperature: 0.7,
  topP: 0.8,
  topK: 20,
  repetitionPenalty: 1.05,
} as const;

/**
 * Qwen3-Coder served through any OpenAI-compatible runtime (vLLM, Ollama, LM Studio, llama.cpp).
 * Adds a fallback for runtimes that return tool calls as text rather than structured `tool_calls`.
 */
export class QwenProvider extends OpenAICompatibleProvider {
  constructor(opts: Partial<OpenAICompatibleOptions> = {}) {
    super({
      baseUrl: QWEN_DEFAULT_BASE_URL,
      model: QWEN_DEFAULT_MODEL,
      id: "qwen",
      name: "Qwen3-Coder (OpenAI-compatible)",
      ...opts,
    });
  }

  override async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const filter = new ToolTagFilter();
    let visible = "";
    for await (const ev of super.stream(request)) {
      if (ev.type === "text") {
        const out = filter.feed(ev.delta);
        if (out) {
          visible += out;
          yield { type: "text", delta: out };
        }
        continue;
      }
      if (ev.type === "done") {
        const tail = filter.flush();
        if (tail) {
          visible += tail;
          yield { type: "text", delta: tail };
        }
        // postProcess() already converted well-formed text tool calls into structured ones.
        if (ev.response.toolCalls.length === 0 && filter.captured) {
          // Could not parse: surface the raw text rather than silently dropping it.
          visible += filter.captured;
          yield { type: "text", delta: filter.captured };
          yield { type: "done", response: { ...ev.response, content: visible } };
          continue;
        }
        yield ev;
        continue;
      }
      yield ev;
    }
  }

  protected override postProcess(r: ChatResponse): ChatResponse {
    if (r.toolCalls.length === 0 && r.content.includes(TOOL_OPEN)) {
      const { calls } = parseTextToolCalls(r.content);
      if (calls.length) {
        return { ...r, content: r.content.slice(0, r.content.indexOf(TOOL_OPEN)).trim(), toolCalls: calls, finishReason: "tool_calls" };
      }
    }
    return r;
  }
}
