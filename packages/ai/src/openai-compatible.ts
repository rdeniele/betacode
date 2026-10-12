import type { ChatMessage, TokenUsage, ToolCallRequest } from "@betacode/shared";
import { isAbortError } from "@betacode/shared";
import {
  ProviderError,
  type AIProvider,
  type ChatRequest,
  type ChatResponse,
  type FinishReason,
  type ModelInfo,
  type StreamEvent,
} from "./provider";
import { readSse } from "./sse";
import { Agent } from "undici";

// Local models can spend several minutes preparing a large tool call without
// emitting bytes. Node's default five-minute idle timeout interrupts that work.
const inferenceDispatcher = new Agent({ headersTimeout: 30 * 60_000, bodyTimeout: 30 * 60_000 });

export interface OpenAICompatibleOptions {
  baseUrl: string;
  model: string;
  apiKey?: string;
  id?: string;
  name?: string;
  /** Extra headers (e.g. OpenRouter attribution). */
  headers?: Record<string, string>;
  /** Extra body fields merged into every request. */
  extraBody?: Record<string, unknown>;
  /** Send top_k / repetition_penalty (vLLM, llama.cpp, LM Studio accept them). Default true. */
  sendSamplingExtras?: boolean;
  maxRetries?: number;
  fetch?: typeof fetch;
}

export function toWireMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: c.arguments },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

interface PendingToolCall {
  id?: string;
  name: string;
  args: string;
}

export class OpenAICompatibleProvider implements AIProvider {
  readonly id: string;
  readonly name: string;
  protected readonly opts: OpenAICompatibleOptions;
  private readonly doFetch: typeof fetch;

  constructor(opts: OpenAICompatibleOptions) {
    this.opts = { sendSamplingExtras: true, maxRetries: 2, ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, "") };
    this.id = opts.id ?? "openai-compatible";
    this.name = opts.name ?? "OpenAI-compatible";
    this.doFetch = opts.fetch ?? fetch;
  }

  supportsTools(): boolean {
    return true;
  }

  protected headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json", ...this.opts.headers };
    if (this.opts.apiKey) h.Authorization = `Bearer ${this.opts.apiKey}`;
    return h;
  }

  protected buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: req.model ?? this.opts.model,
      messages: req.messages.map(toWireMessage),
      stream,
      ...this.opts.extraBody,
    };
    if (stream) body.stream_options = { include_usage: true };
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.topP !== undefined) body.top_p = req.topP;
    if (req.maxTokens !== undefined) body.max_tokens = req.maxTokens;
    if (this.opts.sendSamplingExtras) {
      if (req.topK !== undefined) body.top_k = req.topK;
      if (req.repetitionPenalty !== undefined) body.repetition_penalty = req.repetitionPenalty;
    }
    return body;
  }

  /** POST with retry on connection failures, 429 and 5xx (before any bytes are consumed). */
  private async post(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
    const max = this.opts.maxRetries ?? 0;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= max; attempt++) {
      try {
        const res = await this.doFetch(`${this.opts.baseUrl}${path}`, {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify(body),
          signal,
          ...(!this.opts.fetch ? { dispatcher: inferenceDispatcher } : {}),
        });
        if (res.ok) return res;
        const text = await res.text().catch(() => "");
        const retryable = res.status === 429 || res.status >= 500;
        const err = new ProviderError(`Model endpoint returned HTTP ${res.status}: ${text.slice(0, 500)}`, res.status, retryable);
        if (!retryable || attempt === max) throw err;
        lastErr = err;
      } catch (e) {
        if (isAbortError(e) || signal?.aborted) throw e;
        if (e instanceof ProviderError && !e.retryable) throw e;
        lastErr = e instanceof ProviderError ? e : new ProviderError(`Cannot reach model endpoint ${this.opts.baseUrl}: ${(e as Error).message}`, undefined, true);
        if (attempt === max) throw lastErr;
      }
      await sleep(300 * 2 ** attempt, signal);
    }
    throw lastErr;
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const res = await this.post("/chat/completions", this.buildBody(request, false), request.signal);
    let json: any;
    try {
      json = await res.json();
    } catch {
      throw new ProviderError("Model endpoint returned a non-JSON response.");
    }
    const choice = json?.choices?.[0];
    if (!choice?.message) throw new ProviderError("Malformed response: missing choices[0].message");
    const toolCalls: ToolCallRequest[] = (choice.message.tool_calls ?? []).map((c: any, i: number) => ({
      id: c.id || freshCallId(i),
      name: c.function?.name ?? "",
      arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? {}),
    }));
    return this.postProcess({
      content: choice.message.content ?? "",
      toolCalls,
      finishReason: mapFinish(choice.finish_reason, toolCalls.length > 0),
      usage: mapUsage(json.usage),
    });
  }

  async *stream(request: ChatRequest): AsyncGenerator<StreamEvent> {
    const res = await this.post("/chat/completions", this.buildBody(request, true), request.signal);
    if (!res.body) throw new ProviderError("Model endpoint returned no response body.");
    const pending = new Map<number, PendingToolCall>();
    let content = "";
    let finish: string | null = null;
    let usage: TokenUsage | undefined;
    let completed = false;

    try {
      for await (const data of readSse(res.body, request.signal)) {
        if (data.trim() === "[DONE]") { completed = true; break; }
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          throw new ProviderError(`Malformed stream chunk from model endpoint: ${data.slice(0, 120)}`);
        }
        if (chunk.error) throw new ProviderError(`Model endpoint error: ${chunk.error.message ?? JSON.stringify(chunk.error)}`);
        if (chunk.usage) {
          usage = mapUsage(chunk.usage);
          if (usage) yield { type: "usage", usage };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          content += delta.content;
          yield { type: "text", delta: delta.content };
        }
        for (const tc of delta.tool_calls ?? []) {
          const index: number = tc.index ?? 0;
          const cur = pending.get(index) ?? { name: "", args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          const argDelta = typeof tc.function?.arguments === "string" ? tc.function.arguments : tc.function?.arguments !== undefined ? JSON.stringify(tc.function.arguments) : "";
          cur.args += argDelta;
          pending.set(index, cur);
          yield { type: "tool_call_delta", index, id: tc.id, name: tc.function?.name, argumentsDelta: argDelta || undefined };
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (error) {
      if (request.signal?.aborted || isAbortError(error) || error instanceof ProviderError) throw error;
      throw new ProviderError("The model connection was interrupted before its response finished. Completed edits are saved; retry the task to continue.", undefined, true);
    }
    if (request.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    if (!completed && !finish) {
      throw new ProviderError("The model connection closed before its response finished. Completed edits are saved; retry the task to continue.", undefined, true);
    }

    const toolCalls: ToolCallRequest[] = [...pending.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, c]) => c.name)
      .map(([i, c]) => ({ id: c.id || freshCallId(i), name: c.name, arguments: c.args || "{}" }));
    const response = this.postProcess({
      content,
      toolCalls,
      finishReason: mapFinish(finish, toolCalls.length > 0),
      usage,
    });
    yield { type: "done", response };
  }

  async getModels(): Promise<ModelInfo[]> {
    let res: Response;
    try {
      res = await this.doFetch(`${this.opts.baseUrl}/models`, { headers: this.headers() });
    } catch (e) {
      throw new ProviderError(`Cannot reach model endpoint ${this.opts.baseUrl}: ${(e as Error).message}`, undefined, true);
    }
    if (!res.ok) throw new ProviderError(`Model endpoint returned HTTP ${res.status} for /models`, res.status);
    const json: any = await res.json().catch(() => ({}));
    const list: any[] = Array.isArray(json?.data) ? json.data : Array.isArray(json?.models) ? json.models : [];
    return list.map((m) => ({
      id: String(m.id ?? m.name ?? m.model),
      contextLength: numberOrUndefined(m.max_model_len ?? m.context_length ?? m.context_window),
    }));
  }

  /** Hook for subclasses to repair provider quirks (e.g. tool calls emitted as text). */
  protected postProcess(r: ChatResponse): ChatResponse {
    return r;
  }
}

/** Some servers omit tool-call ids; ids must be unique within a conversation. */
function freshCallId(i: number): string {
  return `call_${i}_${Math.random().toString(36).slice(2, 8)}`;
}

function mapFinish(reason: string | null | undefined, hasTools: boolean): FinishReason {
  if (hasTools) return "tool_calls";
  switch (reason) {
    case "stop":
      return "stop";
    case "tool_calls":
    case "function_call":
      return "tool_calls";
    case "length":
      return "length";
    case null:
    case undefined:
      return "unknown";
    default:
      return "unknown";
  }
}

function mapUsage(u: any): TokenUsage | undefined {
  if (!u || typeof u !== "object") return undefined;
  return { inputTokens: Number(u.prompt_tokens ?? 0), outputTokens: Number(u.completion_tokens ?? 0) };
}

function numberOrUndefined(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(Object.assign(new Error("Aborted"), { name: "AbortError" }));
      },
      { once: true },
    );
  });
}
