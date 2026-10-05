import type { AgentEvent, ChatMessage } from "./types";

export type ToolStatus = "running" | "ok" | "failed" | "denied";

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean }
  | { kind: "tool"; id: string; name: string; args: unknown; status: ToolStatus; output: string; content?: string; durationMs?: number }
  | { kind: "notice"; id: string; tone: "info" | "error"; text: string };

let counter = 0;
const uid = (p: string) => `${p}-${++counter}`;

/** Does a tool result describe a failure? Mirrors the runtime's conventions. */
export function toolFailed(content: string): { failed: boolean; denied: boolean } {
  const denied = /^Denied:/.test(content);
  return { denied, failed: denied || /^Error:/.test(content) || /exit code: (?!0\b)\d+/.test(content) || /\[timed out/.test(content) };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/** Rebuild the transcript from persisted messages (used when opening/resuming a session). */
export function itemsFromMessages(messages: ChatMessage[]): ChatItem[] {
  const results = new Map<string, string>();
  const used = new Set<number>();
  messages.forEach((m, i) => {
    if (m.role === "tool" && m.toolCallId) results.set(`${m.toolCallId}#${i}`, m.content);
  });
  const items: ChatItem[] = [];
  messages.forEach((m, idx) => {
    if (m.role === "user") {
      const text = m.content.replace(/^\[Summary of the earlier conversation[\s\S]*?\n\n---\n\n/, "");
      items.push({ kind: "user", id: uid("u"), text });
    } else if (m.role === "assistant") {
      if (m.content.trim()) items.push({ kind: "assistant", id: uid("a"), text: m.content, streaming: false });
      for (const c of m.toolCalls ?? []) {
        // Find this call's result: the first unused tool message after this assistant message with a matching id.
        let content: string | undefined;
        for (let j = idx + 1; j < messages.length; j++) {
          const t = messages[j]!;
          if (t.role === "tool" && t.toolCallId === c.id && !used.has(j)) {
            used.add(j);
            content = t.content;
            break;
          }
        }
        const f = content === undefined ? { failed: false, denied: false } : toolFailed(content);
        items.push({
          kind: "tool",
          id: uid("t"),
          name: c.name,
          args: safeParse(c.arguments),
          status: content === undefined ? "failed" : f.denied ? "denied" : f.failed ? "failed" : "ok",
          output: "",
          content,
        });
      }
    }
  });
  return items;
}

/** Apply one live agent event to the transcript. Pure. */
export function applyEvent(items: ChatItem[], e: AgentEvent): ChatItem[] {
  switch (e.type) {
    case "agent.message": {
      const m = e.message;
      if (m.role === "user") return [...items, { kind: "user", id: uid("u"), text: m.content }];
      if (m.role === "assistant") {
        const last = items[items.length - 1];
        if (last?.kind === "assistant" && last.streaming) {
          const rest = items.slice(0, -1);
          // Final content replaces the streamed text; drop the bubble when the turn was tool-only.
          return m.content.trim() ? [...rest, { ...last, text: m.content, streaming: false }] : rest;
        }
        return m.content.trim() ? [...items, { kind: "assistant", id: uid("a"), text: m.content, streaming: false }] : items;
      }
      return items;
    }
    case "agent.text": {
      const last = items[items.length - 1];
      if (last?.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, text: last.text + e.delta }];
      return [...items, { kind: "assistant", id: uid("a"), text: e.delta, streaming: true }];
    }
    case "tool.started": {
      // Streaming text that precedes a tool call is already finalised by agent.message; make sure no bubble is left streaming.
      return [...items.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i)), { kind: "tool", id: e.callId, name: e.name, args: e.args, status: "running", output: "" }];
    }
    case "tool.output":
      return items.map((i) => (i.kind === "tool" && i.id === e.callId ? { ...i, output: (i.output + e.chunk).slice(-20000) } : i));
    case "tool.completed": {
      const f = toolFailed(e.content);
      return items.map((i) => (i.kind === "tool" && i.id === e.callId ? { ...i, status: f.denied ? "denied" : e.ok ? "ok" : "failed", content: e.content, durationMs: e.durationMs } : i));
    }
    case "model.error":
      return [...items, { kind: "notice", id: uid("n"), tone: "error", text: `Model error: ${e.message}` }];
    case "session.compacted":
      return [...items, { kind: "notice", id: uid("n"), tone: "info", text: "Earlier conversation was summarised to save context." }];
    case "agent.completed": {
      const done = items.map((i) => (i.kind === "assistant" && i.streaming ? { ...i, streaming: false } : i.kind === "tool" && i.status === "running" ? { ...i, status: "failed" as const } : i));
      if (e.reason === "completed") return done;
      const text: Record<string, string> = {
        cancelled: "Stopped.",
        permission_denied: "Stopped because an action was denied.",
        max_iterations: e.message ?? "Stopped: step limit reached.",
        error: e.message ?? "The agent stopped because of an error.",
      };
      return [...done, { kind: "notice", id: uid("n"), tone: e.reason === "error" ? "error" : "info", text: text[e.reason] ?? e.reason }];
    }
    default:
      return items;
  }
}

export function notice(items: ChatItem[], text: string, tone: "info" | "error" = "info"): ChatItem[] {
  return [...items, { kind: "notice", id: uid("n"), tone, text }];
}

/** Brief one-line description of a tool call's arguments. */
export function describeArgs(name: string, args: unknown): string {
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
  const v = a.path ?? a.command ?? a.query ?? a.pattern ?? a.from ?? a.task ?? a.message ?? a.create ?? a.branch;
  if (typeof v === "string") return v.replace(/\s+/g, " ").slice(0, 140);
  if (name === "update_plan" && Array.isArray(a.steps)) return `${a.steps.length} steps`;
  return "";
}
