import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProgressMonitor } from "../src/progress";
import { allow, call, harness, nodeCmd, say, use, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

describe("offline progress recovery", () => {
  it("detects alternating cycles and normalizes argument key order", () => {
    const monitor = new ProgressMonitor();
    for (let i = 0; i < 2; i++) {
      expect(monitor.observe("read_file", '{"path":"a","start":1}', "a")).toBe(false);
      expect(monitor.observe("read_file", '{"path":"b"}', "b")).toBe(false);
    }
    expect(monitor.observe("read_file", '{"start":1,"path":"a"}', "a")).toBe(false);
    expect(monitor.observe("read_file", '{"path":"b"}', "b")).toBe(true);
  });

  it("does not confuse changed output or a reset with stalled work", () => {
    const monitor = new ProgressMonitor();
    for (let i = 0; i < 6; i++) expect(monitor.observe("read_file", "{}", String(i))).toBe(false);
    monitor.reset();
    expect(monitor.observe("read_file", "{}", "5")).toBe(false);
  });

  it("asks the same local provider to change approach, then allows completion", async () => {
    const read = () => use(call("read_file", { path: "a.txt" }));
    h = harness([read(), read(), read(), say("The file contains hello.")], {
      setup: (dir) => writeFileSync(join(dir, "a.txt"), "hello"),
    });
    const result = await h.session.run("inspect a.txt");
    expect(result.reason).toBe("completed");
    expect(h.provider.requests[3]!.messages.at(-1)!.content).toContain("Stop that cycle");
    expect(h.events.some((e) => e.type === "agent.notice" && e.message.includes("unchanged reads"))).toBe(true);
  });

  it("stops a persistent read loop before exhausting the iteration budget", async () => {
    h = harness(Array.from({ length: 6 }, () => use(call("read_file", { path: "a.txt" }))), {
      setup: (dir) => writeFileSync(join(dir, "a.txt"), "hello"),
    });
    const result = await h.session.run("inspect");
    expect(result).toMatchObject({ reason: "error", steps: 6 });
    expect(result.message).toContain("after a recovery reminder");
  });

  it("does not carry observations into another user turn", async () => {
    const read = () => use(call("read_file", { path: "a.txt" }));
    h = harness([read(), read(), say("First answer."), read(), read(), say("Second answer.")], {
      setup: (dir) => writeFileSync(join(dir, "a.txt"), "hello"),
    });
    await h.session.run("inspect");
    expect((await h.session.run("inspect again")).reason).toBe("completed");
    expect(h.events.some((e) => e.type === "agent.notice")).toBe(false);
  });

  it("resets observations after an edit so rereading changed work is allowed", async () => {
    const read = () => use(call("read_file", { path: "a.txt" }));
    h = harness([read(), read(), use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" })), read(), read(), say("Updated a.txt.")], {
      prompter: allow,
      setup: (dir) => writeFileSync(join(dir, "a.txt"), "hello"),
    });
    expect((await h.session.run("edit")).reason).toBe("completed");
    expect(h.events.some((e) => e.type === "agent.notice")).toBe(false);
  });

  it("returns a failed check to the local model for repair before accepting a final answer", async () => {
    h = harness([
      use(call("run_command", { command: `${nodeCmd("process.exit(1)")} && echo test` })),
      say("Done."),
      use(call("run_command", { command: `${nodeCmd("process.exit(0)")} && echo test` })),
      say("The check now passes."),
    ], { prompter: allow });
    const result = await h.session.run("verify");
    expect(result).toMatchObject({ reason: "completed", finalText: "The check now passes." });
    expect(h.provider.requests[2]!.messages.at(-1)!.content).toContain("latest verification check failed");
  });

  it("allows an honest blocker report after one failed-check reminder", async () => {
    h = harness([
      use(call("run_command", { command: `${nodeCmd("process.exit(1)")} && echo test` })),
      say("Done."),
      say("The check failed; I cannot resolve the environment failure."),
    ], { prompter: allow });
    expect((await h.session.run("verify")).finalText).toContain("check failed");
    expect(h.provider.requests).toHaveLength(3);
  });
});
