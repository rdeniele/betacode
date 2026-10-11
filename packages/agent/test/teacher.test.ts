import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PermissionRequest } from "@betacode/shared";
import { call, harness, nodeCmd, say, use, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const stuckStudent = () => [1, 2, 3, 4].map(() => use(call("read_file", { path: "missing.txt" })));
const withFile = (d: string) => writeFileSync(join(d, "a.txt"), "hello\n");

describe("teacher escalation", () => {
  it("asks for consent, naming where the conversation goes, then the teacher finishes the task", async () => {
    const asked: PermissionRequest[] = [];
    h = harness([...stuckStudent(), say("student should never be asked again")], {
      setup: withFile,
      teacherScript: [use(call("read_file", { path: "a.txt" })), say("The file a.txt says hello. Done.")],
      prompter: async (req) => (asked.push(req), "allow_once"),
      config: { maxIterations: 20 },
    });
    const r = await h.session.run("read the greeting file");
    expect(r).toMatchObject({ reason: "completed", finalText: "The file a.txt says hello. Done." });

    const consent = asked.find((a) => a.tool === "escalate_to_teacher")!;
    expect(consent.summary).toContain("Teacher Pro");
    expect(consent.summary).toContain("api.teacher.test");
    expect(consent.detail).toMatch(/will be sent to api\.teacher\.test/);
    expect(consent.riskLevel).toBe("confirm");

    expect(h.provider.requests).toHaveLength(4); // the student stopped after being replaced
    const t = h.teacherProvider!.requests;
    expect(t).toHaveLength(2);
    expect(t[0]).toMatchObject({ model: "teacher-model", temperature: 0.3 });
    expect(t[0]!.topK).toBeUndefined();
    expect(t[0]!.messages.at(-1)!.content).toMatch(/stronger model \(Teacher Pro\) is taking over.*failed 4 times/s);
    expect(t[0]!.messages.some((m) => m.role === "tool" && m.content.includes("File not found"))).toBe(true); // it sees what happened
    expect(h.events.find((e) => e.type === "agent.notice")).toMatchObject({ level: "info" });
  });

  it("does nothing without consent and falls back to the usual stop", async () => {
    h = harness(stuckStudent(), {
      teacherScript: [say("should not be called")],
      prompter: async (req) => (req.tool === "escalate_to_teacher" ? "deny" : "allow_once"),
      config: { maxIterations: 20 },
    });
    const r = await h.session.run("read it");
    expect(r.reason).toBe("error");
    expect(r.message).toMatch(/failed 4 times/);
    expect(h.teacherProvider!.requests).toHaveLength(0);
  });

  it("without a teacher configured nothing changes", async () => {
    h = harness(stuckStudent(), { prompter: async () => "allow_once", config: { maxIterations: 20 } });
    const r = await h.session.run("read it");
    expect(r.reason).toBe("error");
  });

  it("escalates at most once per run", async () => {
    let prompts = 0;
    h = harness(stuckStudent(), {
      teacherScript: stuckStudent(),
      prompter: async (req) => (req.tool === "escalate_to_teacher" && prompts++, "allow_once"),
      config: { maxIterations: 30 },
    });
    const r = await h.session.run("read it");
    expect(prompts).toBe(1);
    expect(r.reason).toBe("error");
  });

  it("is triggered when the project's checks keep failing, and the teacher can fix it", async () => {
    const failing = (i: number) => use(call("run_command", { command: `${nodeCmd(`console.error('FAIL ${i}');process.exit(1)`)} && echo test` }));
    h = harness([failing(1), failing(2), failing(3), say("student gives up")], {
      setup: withFile,
      teacherScript: [use(call("read_file", { path: "a.txt" })), use(call("write_file", { path: "a.txt", content: "fixed\n" })), use(call("run_command", { command: `${nodeCmd("process.exit(0)")} && echo test` })), say("Fixed a.txt.")],
      prompter: async () => "allow_once",
      config: { maxRetries: 2, maxIterations: 30 },
    });
    const r = await h.session.run("fix the failing check");
    expect(r).toMatchObject({ reason: "completed", finalText: "Fixed a.txt." });
    expect(readFileSync(join(h.dir, "a.txt"), "utf8")).toBe("fixed\n");
    expect(h.teacherProvider!.requests[0]!.messages.at(-1)!.content).toMatch(/checks are still failing after 2 attempts/);
    // The teacher is given tools again (the student had been cut off from them).
    expect(h.teacherProvider!.requests[0]!.tools).toBeDefined();
  });

  it("the next run starts with the local model again", async () => {
    h = harness([...stuckStudent(), say("local model is back")], {
      setup: withFile,
      teacherScript: [say("Teacher answer.")],
      prompter: async () => "allow_once",
      config: { maxIterations: 20 },
    });
    await h.session.run("first");
    const r = await h.session.run("second");
    expect(r.finalText).toBe("local model is back");
    expect(h.teacherProvider!.requests).toHaveLength(1);
  });

  it("is never used by sub-agents", async () => {
    h = harness(
      [
        use(call("delegate_task", { task: "look around" })),
        ...[1, 2, 3, 4].map(() => use(call("read_file", { path: "nope.txt" }))), // sub-agent gets stuck
        say("sub-agent gave up"),
        say("parent done"),
      ],
      { teacherScript: [say("teacher should not run")], prompter: async () => "allow_once", config: { maxIterations: 30 } },
    );
    await h.session.run("investigate");
    expect(h.teacherProvider!.requests).toHaveLength(0);
  });
});
