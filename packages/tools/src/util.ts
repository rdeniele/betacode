import { BetaCodeError, isAbortError } from "@betacode/shared";
import type { ToolResult } from "./types";

/** Cap very large tool output so it cannot flood the model context. */
export function truncate(text: string, max = 24_000): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${text.slice(0, head)}\n… [${text.length - max} characters truncated] …\n${text.slice(text.length - tail)}`;
}

export function fail(message: string): ToolResult {
  return { ok: false, content: `Error: ${message}` };
}

/** Run a tool body, converting expected errors into a failed ToolResult the model can read. */
export async function guard(fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (isAbortError(e)) throw e;
    if (e instanceof BetaCodeError) return fail(e.message);
    return fail(`${(e as Error).name}: ${(e as Error).message}`);
  }
}

export function pluralize(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
