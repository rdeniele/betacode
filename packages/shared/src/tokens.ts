import type { ChatMessage } from "./types";

/** Cheap token estimate (~4 chars/token). Real usage from the provider is preferred when known. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessageTokens(m: ChatMessage): number {
  let n = estimateTokens(m.content) + 4;
  if (m.toolCalls) for (const c of m.toolCalls) n += estimateTokens(c.name + c.arguments) + 4;
  return n;
}

export function estimateMessagesTokens(ms: ChatMessage[]): number {
  return ms.reduce((a, m) => a + estimateMessageTokens(m), 0);
}
