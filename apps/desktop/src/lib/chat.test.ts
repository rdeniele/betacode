import { describe, expect, it } from "vitest";
import { applyEvent, itemsFromMessages, toolFailed, type ChatItem } from "./chat";
import type { AgentEvent } from "./types";

const run = (events: AgentEvent[], start: ChatItem[] = []) => events.reduce(applyEvent, start);

describe("applyEvent", () => {
  it("streams assistant text into one bubble, then finalises it", () => {
    const items = run([
      { type: "agent.message", message: { role: "user", content: "hi" } },
      { type: "agent.text", delta: "Hel" },
      { type: "agent.text", delta: "lo" },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(items[1]).toMatchObject({ text: "Hello", streaming: true });
    const done = applyEvent(items, { type: "agent.message", message: { role: "assistant", content: "Hello" } });
    expect(done[1]).toMatchObject({ text: "Hello", streaming: false });
    expect(done).toHaveLength(2);
  });

  it("removes the empty bubble for tool-only turns and tracks tool lifecycle", () => {
    const items = run([
      { type: "agent.text", delta: "Let me look." },
      { type: "agent.message", message: { role: "assistant", content: "Let me look.", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] } },
      { type: "tool.started", callId: "c1", name: "read_file", args: { path: "a.ts" } },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    expect(items[1]).toMatchObject({ status: "running", name: "read_file" });
    const after = run(
      [
        { type: "tool.output", callId: "c1", chunk: "partial " },
        { type: "tool.output", callId: "c1", chunk: "output" },
        { type: "tool.completed", callId: "c1", name: "read_file", ok: true, content: "1\tx", durationMs: 7 },
      ],
      items,
    );
    expect(after[1]).toMatchObject({ status: "ok", output: "partial output", durationMs: 7 });
  });

  it("marks failures and denials", () => {
    const base = run([{ type: "tool.started", callId: "a", name: "run_command", args: { command: "npm test" } }, { type: "tool.started", callId: "b", name: "write_file", args: {} }]);
    const out = run(
      [
        { type: "tool.completed", callId: "a", name: "run_command", ok: false, content: "$ npm test\nexit code: 1", durationMs: 1 },
        { type: "tool.completed", callId: "b", name: "write_file", ok: false, content: "Denied: nope", durationMs: 0 },
      ],
      base,
    );
    expect(out.map((i) => (i.kind === "tool" ? i.status : ""))).toEqual(["failed", "denied"]);
  });

  it("adds notices for errors, cancellation and compaction; closes running tools", () => {
    const base = run([{ type: "tool.started", callId: "a", name: "run_command", args: {} }]);
    const out = run([{ type: "session.compacted", summary: "x" }, { type: "agent.completed", reason: "cancelled" }], base);
    expect(out.find((i) => i.kind === "tool")).toMatchObject({ status: "failed" });
    expect(out.filter((i) => i.kind === "notice").map((n) => (n as { text: string }).text)).toEqual(["Earlier conversation was summarised to save context.", "Stopped."]);
    expect(run([{ type: "agent.completed", reason: "completed" }])).toEqual([]);
    expect(run([{ type: "model.error", message: "down" }])[0]).toMatchObject({ kind: "notice", tone: "error" });
  });
});

describe("itemsFromMessages", () => {
  it("rebuilds user, assistant and tool items and pairs results by call id", () => {
    const items = itemsFromMessages([
      { role: "user", content: "fix it" },
      { role: "assistant", content: "Running tests", toolCalls: [{ id: "x", name: "run_command", arguments: '{"command":"npm test"}' }] },
      { role: "tool", toolCallId: "x", content: "$ npm test\nexit code: 1" },
      { role: "assistant", content: "", toolCalls: [{ id: "x", name: "run_command", arguments: '{"command":"npm test"}' }] },
      { role: "tool", toolCallId: "x", content: "$ npm test\nexit code: 0" },
      { role: "assistant", content: "All green." },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(items[2]).toMatchObject({ status: "failed", args: { command: "npm test" } });
    expect(items[3]).toMatchObject({ status: "ok" });
  });

  it("hides the compaction summary prefix from the user message", () => {
    const items = itemsFromMessages([{ role: "user", content: "[Summary of the earlier conversation — it was compacted to save context]\nTask: x\n\n---\n\nnext request" }]);
    expect(items[0]).toMatchObject({ text: "next request" });
  });
});

describe("toolFailed", () => {
  it("detects the runtime's failure conventions", () => {
    expect(toolFailed("Error: nope").failed).toBe(true);
    expect(toolFailed("Denied: user said no")).toEqual({ failed: true, denied: true });
    expect(toolFailed("exit code: 0  duration: 3ms").failed).toBe(false);
    expect(toolFailed("exit code: 2").failed).toBe(true);
  });
});
