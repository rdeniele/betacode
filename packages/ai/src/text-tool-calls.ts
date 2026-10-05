import type { ToolCallRequest } from "@betacode/shared";

/**
 * Some runtimes (vLLM without `--tool-call-parser`, some GGUF chat templates) return tool calls as text
 * instead of structured `tool_calls`. Qwen3-Coder uses an XML-ish format and Hermes-style models use JSON.
 */

export const TOOL_OPEN = "<tool_call>";

/** Parse every `<tool_call>…</tool_call>` block in `text`. Returns the calls and whether all blocks parsed. */
export function parseTextToolCalls(text: string): { calls: ToolCallRequest[]; complete: boolean } {
  const calls: ToolCallRequest[] = [];
  let complete = true;
  const re = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text)) !== null) {
    const body = (m[1] ?? "").trim();
    if (!body) {
      if (m.index === re.lastIndex) re.lastIndex++;
      continue;
    }
    const call = parseQwenXml(body) ?? parseHermesJson(body);
    if (call) calls.push({ id: `text_call_${n++}`, ...call });
    else complete = false;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return { calls, complete };
}

function parseQwenXml(body: string): { name: string; arguments: string } | null {
  const fn = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/.exec(body);
  if (!fn) return null;
  const name = fn[1]!;
  const args: Record<string, unknown> = {};
  const pr = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g;
  let p: RegExpExecArray | null;
  while ((p = pr.exec(fn[2]!)) !== null) {
    args[p[1]!] = coerce(p[2]!.replace(/^\r?\n/, "").replace(/\r?\n$/, ""));
  }
  return { name, arguments: JSON.stringify(args) };
}

function parseHermesJson(body: string): { name: string; arguments: string } | null {
  try {
    const j = JSON.parse(body);
    if (j && typeof j.name === "string") {
      const a = j.arguments ?? j.parameters ?? {};
      return { name: j.name, arguments: typeof a === "string" ? a : JSON.stringify(a) };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function coerce(v: string): unknown {
  const t = v.trim();
  if (t === "true") return true;
  if (t === "false") return false;
  if (t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

/** Incrementally hides `<tool_call>` blocks from streamed assistant text. */
export class ToolTagFilter {
  private held = "";
  private inTool = false;
  captured = "";

  /** Returns the portion of `delta` that is safe to show to the user. */
  feed(delta: string): string {
    if (this.inTool) {
      this.captured += delta;
      return "";
    }
    const s = this.held + delta;
    const i = s.indexOf(TOOL_OPEN);
    if (i >= 0) {
      this.inTool = true;
      this.captured = s.slice(i);
      this.held = "";
      return s.slice(0, i);
    }
    let keep = 0;
    for (let k = Math.min(TOOL_OPEN.length - 1, s.length); k > 0; k--) {
      if (TOOL_OPEN.startsWith(s.slice(s.length - k))) {
        keep = k;
        break;
      }
    }
    this.held = s.slice(s.length - keep);
    return s.slice(0, s.length - keep);
  }

  /** Text that was being held back but turned out not to be a tool tag. */
  flush(): string {
    const out = this.inTool ? "" : this.held;
    this.held = "";
    return out;
  }

  get active(): boolean {
    return this.inTool;
  }
}
