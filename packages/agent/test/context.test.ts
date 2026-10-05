import { afterEach, describe, expect, it } from "vitest";
import type { ChatMessage } from "@betacode/shared";
import { estimateMessagesTokens } from "@betacode/shared";
import { ContextManager, SUMMARY_MARKER, fallbackSummary } from "../src";
import { ScriptedProvider, call, harness, say, use, type Harness } from "./helpers";

const big = (n: number) => "x".repeat(n);
const budget = (contextLimit: number) => ({ contextLimit, outputReserve: 0, fixedTokens: 0 });
const facts = { modifiedFiles: ["src/auth.ts"], plan: [{ text: "Add login", status: "in_progress" as const }] };

function conversation(turns: number): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: "user", content: `request ${i}` });
    out.push({ role: "assistant", content: "", toolCalls: [{ id: `t${i}`, name: "read_file", arguments: "{}" }] });
    out.push({ role: "tool", toolCallId: `t${i}`, name: "read_file", content: big(2000) });
    out.push({ role: "assistant", content: `answer ${i}` });
  }
  return out;
}

describe("ContextManager", () => {
  it("detects when the budget is exceeded", () => {
    const cm = new ContextManager();
    const msgs = conversation(10);
    expect(cm.needsCompaction(msgs, budget(100_000))).toBe(false);
    expect(cm.needsCompaction(msgs, budget(4_000))).toBe(true);
  });

  it("accounts for system prompt/tool tokens in the budget", () => {
    const cm = new ContextManager();
    const msgs = conversation(2);
    expect(cm.needsCompaction(msgs, { contextLimit: 8_000, outputReserve: 0, fixedTokens: 0 })).toBe(false);
    expect(cm.needsCompaction(msgs, { contextLimit: 8_000, outputReserve: 0, fixedTokens: 6_000 })).toBe(true);
  });

  it("prunes old tool outputs before resorting to summarisation", async () => {
    const cm = new ContextManager();
    const msgs = conversation(6);
    const provider = new ScriptedProvider([]);
    const limit = Math.ceil(estimateMessagesTokens(msgs) * 0.7); // pruned history fits within ~0.8 * limit
    const r = (await cm.compact(msgs, budget(limit), facts, provider, "m"))!;
    expect(r.usedModel).toBe(false);
    expect(provider.requests).toHaveLength(0);
    expect(r.history).toHaveLength(msgs.length);
    expect(r.history[2]!.content).toContain("omitted");
    expect(estimateMessagesTokens(r.history)).toBeLessThan(estimateMessagesTokens(msgs));
  });

  it("summarises with the model, preserving state and never splitting tool exchanges", async () => {
    const cm = new ContextManager();
    const msgs = conversation(12);
    const provider = new ScriptedProvider([
      say("Task:\nAdd login\n\nCompleted:\nread files\n\nFiles modified:\nsrc/auth.ts\n\nCurrent errors:\nnone\n\nImportant decisions:\nuse sessions\n\nNext action:\nwrite middleware"),
    ]);
    const r = (await cm.compact(msgs, budget(3_000), facts, provider, "m"))!;
    expect(r.usedModel).toBe(true);
    expect(r.history[0]!.role).toBe("user");
    expect(r.history[0]!.content).toContain(SUMMARY_MARKER);
    expect(r.history[0]!.content).toContain("Files modified so far: src/auth.ts");
    expect(r.history[0]!.content).toContain("Next action");
    expect(r.history.length).toBeLessThan(msgs.length);
    // The kept tail never starts with an orphaned tool message and every tool message has its assistant call.
    expect(r.history[1]?.role).not.toBe("tool");
    const callIds = new Set(r.history.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? []));
    for (const m of r.history) if (m.role === "tool") expect(callIds.has(m.toolCallId!)).toBe(true);
    // The latest request is preserved verbatim.
    expect(r.history.at(-1)!.content).toBe("answer 11");
    expect(r.folded + (r.history.length - 1)).toBeGreaterThanOrEqual(msgs.length - 1);
    // The summariser was told what to produce and was given the facts.
    expect(provider.requests[0]!.messages[0]!.content).toContain("Next action");
    expect(provider.requests[0]!.messages[1]!.content).toContain("src/auth.ts");
  });

  it("falls back to a deterministic summary when the model fails", async () => {
    const cm = new ContextManager();
    const msgs = conversation(12);
    msgs.splice(5, 0, { role: "tool", toolCallId: "e", name: "run_command", content: "$ pnpm test\nexit code: 1  duration: 5ms\nTypeError: boom" });
    const provider = new ScriptedProvider([() => Promise.reject(new Error("down"))]);
    const r = (await cm.compact(msgs, budget(3_000), facts, provider, "m"))!;
    expect(r.usedModel).toBe(false);
    expect(r.summary).toContain("request 0");
    expect(r.summary).toContain("src/auth.ts");
    expect(r.history[0]!.content).toContain("Files modified so far: src/auth.ts");
  });

  it("fallbackSummary lists recent errors", () => {
    const s = fallbackSummary([{ role: "user", content: "fix" }, { role: "tool", content: "Error: nope", toolCallId: "1" }], facts);
    expect(s).toContain("Current errors:\nError: nope");
  });

  it("merges the summary into a leading user message", async () => {
    const cm = new ContextManager();
    const msgs = conversation(12);
    const provider = new ScriptedProvider([say("Task:\nx\nCompleted:\ny\nFiles modified:\nz\nCurrent errors:\nnone\nImportant decisions:\nd\nNext action:\nn")]);
    const r = (await cm.compact(msgs, budget(3_000), facts, provider, "m"))!;
    for (let i = 1; i < r.history.length; i++) expect(!(r.history[i]!.role === "user" && r.history[i - 1]!.role === "user")).toBe(true);
  });
});

describe("auto-compaction inside the agent", () => {
  let h: Harness | undefined;
  afterEach(() => h?.cleanup());

  it("compacts mid-run when the context fills and keeps working", async () => {
    // contextLength is tiny so the large tool outputs trigger compaction.
    const bigFile = big(6000);
    h = harness(
      [
        use(call("read_file", { path: "big.txt" })),
        use(call("read_file", { path: "big.txt", offset: 1 })),
        use(call("read_file", { path: "big.txt", limit: 100 })),
        // summariser call
        say("Task:\nread\n\nCompleted:\nreads\n\nFiles modified:\nnone\n\nCurrent errors:\nnone\n\nImportant decisions:\nnone\n\nNext action:\nfinish"),
        say("All done."),
      ],
      {
        config: { contextLength: 4096, maxOutputTokens: 256 },
        setup: (d) => require("node:fs").writeFileSync(require("node:path").join(d, "big.txt"), (bigFile + "\n").repeat(3)),
      },
    );
    const r = await h.session.run("read big.txt a few times then finish");
    expect(r.reason).toBe("completed");
    expect(h.events.some((e) => e.type === "session.compacted")).toBe(true);
    expect(h.session.agent.history[0]!.content).toContain(SUMMARY_MARKER);
    expect(h.session.agent.foldedTotal).toBeGreaterThan(0);
  });

  it("manual compact() folds history and reports the summary", async () => {
    h = harness([say("first"), say("Task:\nA\nCompleted:\nB\nFiles modified:\nnone\nCurrent errors:\nnone\nImportant decisions:\nnone\nNext action:\nC")]);
    await h.session.run("one");
    await h.session.run("two");
    const s = await h.session.agent.compact();
    expect(s).toContain("Task:");
    expect(h.session.agent.history[0]!.content).toContain(SUMMARY_MARKER);
  });
});
