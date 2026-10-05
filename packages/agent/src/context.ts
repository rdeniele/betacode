import type { AIProvider } from "@betacode/ai";
import { estimateMessageTokens, estimateMessagesTokens, estimateTokens, type ChatMessage, type PlanItem } from "@betacode/shared";
import { COMPACTION_PROMPT } from "@betacode/prompts";

export const SUMMARY_MARKER = "[Summary of the earlier conversation — it was compacted to save context]";

export interface BudgetInput {
  contextLimit: number;
  /** Tokens reserved for the model's reply. */
  outputReserve: number;
  /** Tokens used by the system prompt and tool definitions. */
  fixedTokens: number;
}

export interface CompactionFacts {
  modifiedFiles: string[];
  plan: PlanItem[];
}

export interface CompactionResult {
  history: ChatMessage[];
  summary: string;
  /** Number of messages from the head of the input history that were folded into the summary. */
  folded: number;
  usedModel: boolean;
}

function isToolFailure(content: string): boolean {
  return /^Error:/.test(content) || /exit code: (?!0\b)\d+/.test(content) || /\[timed out/.test(content);
}

function stub(m: ChatMessage, keep = 400): ChatMessage {
  if (m.role !== "tool" || m.content.length <= keep + 80) return m;
  return { ...m, content: `${m.content.slice(0, keep)}\n… [${m.content.length - keep} characters of older tool output omitted]` };
}

/**
 * Keeps the prompt inside the model's context window.
 *  1. Older tool outputs are shrunk first (cheap, loses little).
 *  2. If still too large, the older conversation is summarised (by the model, with a deterministic fallback)
 *     into Task / Completed / Files modified / Current errors / Important decisions / Next action.
 */
export class ContextManager {
  /** Learned ratio of real prompt tokens to our estimate. */
  private calibration = 1;

  constructor(
    private readonly opts: { threshold?: number; keepRecentTokensFraction?: number } = {},
  ) {}

  /** Update the estimator using a real token count reported by the provider. */
  calibrate(estimated: number, actual: number): void {
    if (estimated < 200 || actual <= 0) return;
    const ratio = Math.min(3, Math.max(0.5, actual / estimated));
    this.calibration = this.calibration * 0.5 + ratio * 0.5;
  }

  estimate(history: ChatMessage[], fixedTokens = 0): number {
    return Math.ceil((estimateMessagesTokens(history) + fixedTokens) * this.calibration);
  }

  limit(b: BudgetInput): number {
    return Math.floor((b.contextLimit - b.outputReserve) * (this.opts.threshold ?? 0.8));
  }

  needsCompaction(history: ChatMessage[], b: BudgetInput): boolean {
    return this.estimate(history, b.fixedTokens) > this.limit(b);
  }

  /** Shrink tool outputs older than the last `keepRecent` messages. */
  pruneToolOutputs(history: ChatMessage[], keepRecent = 8): ChatMessage[] {
    const cut = Math.max(0, history.length - keepRecent);
    return history.map((m, i) => (i < cut ? stub(m) : m));
  }

  async compact(history: ChatMessage[], b: BudgetInput, facts: CompactionFacts, provider: AIProvider, model: string, signal?: AbortSignal, hasSummaryAtHead = false): Promise<CompactionResult | undefined> {
    // Stage 1: prune.
    const pruned = this.pruneToolOutputs(history);
    if (!this.needsCompaction(pruned, b)) {
      return { history: pruned, summary: "", folded: 0, usedModel: false };
    }

    // Stage 2: summarise everything before a clean cut point.
    const cut = this.chooseCut(pruned, b);
    if (cut <= 0) return undefined; // nothing safe to fold
    const head = pruned.slice(0, cut);
    const tail = pruned.slice(cut);

    let summary: string | undefined;
    let usedModel = false;
    try {
      const transcript = renderTranscript(head);
      const res = await provider.chat({
        model,
        signal,
        temperature: 0.2,
        maxTokens: 1200,
        messages: [
          { role: "system", content: COMPACTION_PROMPT },
          { role: "user", content: `${factsBlock(facts)}\n\n--- CONVERSATION TO SUMMARISE ---\n${transcript}` },
        ],
      });
      if (res.content.trim().length > 40) {
        summary = res.content.trim();
        usedModel = true;
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
    }
    summary ??= fallbackSummary(head, facts);

    const summaryText = `${SUMMARY_MARKER}\n${summary}\n\n${factsBlock(facts)}`;
    const next: ChatMessage[] = [];
    if (tail[0]?.role === "user") {
      next.push({ role: "user", content: `${summaryText}\n\n---\n\n${tail[0].content}` }, ...tail.slice(1));
    } else {
      next.push({ role: "user", content: summaryText }, ...tail);
    }
    return { history: next, summary, folded: cut - (hasSummaryAtHead ? 1 : 0), usedModel };
  }

  /** Largest prefix that can be folded while the kept tail fits in ~40% of the budget; never splits tool-call groups. */
  private chooseCut(history: ChatMessage[], b: BudgetInput): number {
    const budget = Math.floor(this.limit(b) * (this.opts.keepRecentTokensFraction ?? 0.4));
    let tailTokens = 0;
    let best = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      tailTokens += estimateMessageTokens(history[i]!);
      if (history[i]!.role === "tool") continue; // never start the tail in the middle of a tool exchange
      if (tailTokens <= budget) best = i;
      else break;
    }
    if (best > 0) return best;
    // Even the last exchange is too large: fold everything before the final user message.
    for (let i = history.length - 1; i > 0; i--) if (history[i]!.role === "user") return i;
    return history.length > 1 ? history.length - 1 : 0;
  }
}

function factsBlock(f: CompactionFacts): string {
  const lines: string[] = ["Known state (authoritative):"];
  lines.push(f.modifiedFiles.length ? `Files modified so far: ${f.modifiedFiles.join(", ")}` : "Files modified so far: none");
  if (f.plan.length) lines.push("Plan:", ...f.plan.map((p) => `  [${p.status}] ${p.text}`));
  return lines.join("\n");
}

function renderTranscript(msgs: ChatMessage[]): string {
  const out: string[] = [];
  for (const m of msgs) {
    if (m.role === "user") out.push(`USER: ${clip(m.content, 2500)}`);
    else if (m.role === "assistant") {
      if (m.content.trim()) out.push(`ASSISTANT: ${clip(m.content, 1500)}`);
      for (const c of m.toolCalls ?? []) out.push(`ASSISTANT CALLED ${c.name}(${clip(c.arguments, 300)})`);
    } else if (m.role === "tool") out.push(`TOOL RESULT: ${clip(m.content, 700)}`);
  }
  return out.join("\n");
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

/** Used when the model cannot summarise: derived mechanically from the transcript so state is never silently lost. */
export function fallbackSummary(head: ChatMessage[], facts: CompactionFacts): string {
  const users = head.filter((m) => m.role === "user").map((m) => m.content.replace(SUMMARY_MARKER, "").trim());
  const calls = head.flatMap((m) => m.toolCalls ?? []);
  const errors = head.filter((m) => m.role === "tool" && isToolFailure(m.content)).slice(-3).map((m) => clip(m.content.replace(/\s+/g, " "), 300));
  const lastAssistant = [...head].reverse().find((m) => m.role === "assistant" && m.content.trim());
  return [
    `Task:\n${clip(users[0] ?? "(unknown)", 600)}${users.length > 1 ? `\nLater requests: ${users.slice(1).map((u) => clip(u, 200)).join(" | ")}` : ""}`,
    `Completed:\n${calls.length} tool call(s) were made (${[...new Set(calls.map((c) => c.name))].join(", ") || "none"}).${lastAssistant ? ` Last assistant note: ${clip(lastAssistant.content, 400)}` : ""}`,
    `Files modified:\n${facts.modifiedFiles.join(", ") || "none"}`,
    `Current errors:\n${errors.join("\n") || "none recorded"}`,
    `Important decisions:\n(not captured — automatic fallback summary)`,
    `Next action:\nContinue the task from the most recent messages.`,
  ].join("\n\n");
}

export { estimateTokens };
