import type { ChatMessage, TokenUsage, ToolCallRequest, ToolSpec } from "@betacode/shared";

export type FinishReason = "stop" | "tool_calls" | "length" | "error" | "unknown";

export interface ChatRequest {
  model?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  toolCalls: ToolCallRequest[];
  finishReason: FinishReason;
  usage?: TokenUsage;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_call_delta"; index: number; id?: string; name?: string; argumentsDelta?: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; response: ChatResponse };

export interface ModelInfo {
  id: string;
  contextLength?: number;
}

export interface AIProvider {
  readonly id: string;
  readonly name: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
  stream(request: ChatRequest): AsyncIterable<StreamEvent>;
  supportsTools(): boolean;
  getModels(): Promise<ModelInfo[]>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Drain a stream into a single response. */
export async function collectStream(events: AsyncIterable<StreamEvent>): Promise<ChatResponse> {
  let text = "";
  let final: ChatResponse | undefined;
  for await (const ev of events) {
    if (ev.type === "text") text += ev.delta;
    if (ev.type === "done") final = ev.response;
  }
  return final ?? { content: text, toolCalls: [], finishReason: "unknown" };
}
