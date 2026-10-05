import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { allow, call, deny, harness, nodeCmd, say, use, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(() => h?.cleanup());

const types = (hh: Harness) => hh.events.map((e) => e.type);
const toolMessages = (hh: Harness) => hh.session.agent.history.filter((m) => m.role === "tool");

describe("agent loop: tool selection and execution", () => {
  it("inspects, edits and finishes across multiple iterations", async () => {
    h = harness(
      [
        use(call("read_file", { path: "src/a.ts" })),
        use(call("edit_file", { path: "src/a.ts", oldText: "= 1", newText: "= 2" })),
        say("Changed a to 2."),
      ],
      {
        prompter: allow,
        setup: (d) => {
          mkdirSync(join(d, "src"));
          writeFileSync(join(d, "src/a.ts"), "export const a = 1;\n");
        },
      },
    );
    const r = await h.session.run("change a to 2");
    expect(r).toMatchObject({ reason: "completed", steps: 3, finalText: "Changed a to 2." });
    expect(readFileSync(join(h.dir, "src/a.ts"), "utf8")).toBe("export const a = 2;\n");
    // The second model request must contain the read_file result.
    const secondReq = h.provider.requests[1]!;
    expect(secondReq.messages.at(-1)).toMatchObject({ role: "tool", name: "read_file" });
    expect(secondReq.messages.at(-1)!.content).toContain("export const a = 1;");
    expect(types(h)).toEqual(expect.arrayContaining(["agent.started", "tool.started", "tool.completed", "file.changed", "permission.requested", "agent.completed"]));
    expect(h.session.changes.list()).toHaveLength(1);
  });

  it("passes tool specs and sampling settings to the model", async () => {
    h = harness([say("hi")], { config: { temperature: 0.3 } });
    await h.session.run("hello");
    const req = h.provider.requests[0]!;
    expect(req.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["read_file", "edit_file", "run_command", "delegate_task", "update_plan"]));
    expect(req.temperature).toBe(0.3);
    expect(req.messages[0]!.role).toBe("system");
    expect(req.messages[0]!.content).toContain("BetaCode");
  });

  it("handles several tool calls in one turn and answers each", async () => {
    h = harness([use(call("list_directory", {}, "x1"), call("find_files", { pattern: "*.txt" }, "x2")), say("done")], {
      setup: (d) => writeFileSync(join(d, "f.txt"), "x"),
    });
    await h.session.run("look");
    expect(toolMessages(h).map((m) => m.toolCallId)).toEqual(["x1", "x2"]);
    expect(toolMessages(h)[1]!.content).toContain("f.txt");
  });

  it("returns invalid JSON and unknown tools to the model so it can recover", async () => {
    h = harness([use(call("read_file", "{not json")), use(call("no_such_tool", {})), use(call("read_file", {})), say("ok")]);
    const r = await h.session.run("go");
    expect(r.reason).toBe("completed");
    const msgs = toolMessages(h).map((m) => m.content);
    expect(msgs[0]).toMatch(/not valid JSON/);
    expect(msgs[1]).toMatch(/Unknown tool "no_such_tool"/);
    expect(msgs[2]).toMatch(/Invalid arguments for read_file: path/);
  });

  it("tells the model when edit_file's oldText does not match, without changing the file", async () => {
    h = harness([use(call("edit_file", { path: "a.txt", oldText: "zzz", newText: "y" })), say("will re-read")], {
      prompter: allow,
      setup: (d) => writeFileSync(join(d, "a.txt"), "hello"),
    });
    await h.session.run("edit");
    expect(toolMessages(h)[0]!.content).toMatch(/not found in a\.txt.*re-read/s);
    expect(readFileSync(join(h.dir, "a.txt"), "utf8")).toBe("hello");
    // A failing edit has nothing to approve, so no prompt was shown.
    expect(types(h)).not.toContain("permission.requested");
  });

  it("blocks reads outside the workspace", async () => {
    h = harness([use(call("read_file", { path: "../../etc/passwd" })), say("blocked")]);
    await h.session.run("read it");
    expect(toolMessages(h)[0]!.content).toMatch(/outside the project workspace/);
  });

  it("does not read .env without explicit approval", async () => {
    h = harness([use(call("read_file", { path: ".env" })), say("ok")], { prompter: deny, setup: (d) => writeFileSync(join(d, ".env"), "API_KEY=abc") });
    const r = await h.session.run("show env");
    expect(r.reason).toBe("permission_denied");
    expect(JSON.stringify(h.session.agent.history)).not.toContain("abc");
  });
});

describe("agent loop: permissions", () => {
  it("stops when the user denies an action and answers the remaining calls", async () => {
    h = harness([use(call("write_file", { path: "x.txt", content: "x" }, "w1"), call("write_file", { path: "y.txt", content: "y" }, "w2")), say("never reached")], { prompter: deny });
    const r = await h.session.run("write");
    expect(r.reason).toBe("permission_denied");
    expect(toolMessages(h).map((m) => m.toolCallId)).toEqual(["w1", "w2"]);
    expect(toolMessages(h)[0]!.content).toMatch(/^Denied/);
    expect(h.session.changes.list()).toHaveLength(0);
    expect(h.provider.requests).toHaveLength(1);
  });

  it("asks before running non-read-only commands and shows them in the request", async () => {
    const seen: string[] = [];
    h = harness([use(call("run_command", { command: nodeCmd("console.log(1)") })), say("ran")], {
      prompter: async (req) => {
        seen.push(`${req.riskLevel}:${req.summary}`);
        return "allow_once";
      },
    });
    await h.session.run("run");
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^confirm:node -e/);
  });

  it("runs safe read-only commands without asking", async () => {
    const asked: string[] = [];
    h = harness([use(call("run_command", { command: "git status" })), say("ok")], { prompter: async (r) => (asked.push(r.summary), "allow_once"), setup: () => {} });
    await h.session.run("status");
    expect(asked).toEqual([]);
  });

  it("never runs dangerous commands without an explicit yes", async () => {
    h = harness([use(call("run_command", { command: "rm -rf node_modules" })), say("ok")]);
    const r = await h.session.run("clean");
    expect(r.reason).toBe("permission_denied");
    expect(toolMessages(h)[0]!.content).toMatch(/no interactive approval/);
  });

  it("autoApprove=confirm approves edits but still refuses dangerous commands", async () => {
    h = harness([use(call("write_file", { path: "ok.txt", content: "1" })), use(call("run_command", { command: "sudo ls" })), say("x")], { autoApprove: "confirm" });
    const r = await h.session.run("go");
    expect(readFileSync(join(h.dir, "ok.txt"), "utf8")).toBe("1");
    expect(r.reason).toBe("permission_denied");
  });

  it("honours allow_session so the same tool is not asked twice", async () => {
    let asks = 0;
    h = harness([use(call("write_file", { path: "1.txt", content: "1" })), use(call("write_file", { path: "2.txt", content: "2" })), say("done")], {
      prompter: async () => (asks++, "allow_session"),
    });
    await h.session.run("two files");
    expect(asks).toBe(1);
    expect(h.session.changes.list()).toHaveLength(2);
  });

  it("config can disable a tool entirely", async () => {
    h = harness([use(call("write_file", { path: "n.txt", content: "1" })), say("x")], { prompter: allow, config: { permissions: { write_file: "deny" } } });
    const r = await h.session.run("write");
    expect(r.reason).toBe("permission_denied");
    expect(toolMessages(h)[0]!.content).toMatch(/disabled by the user/);
  });

  it("read-only modes do not offer or run editing tools", async () => {
    h = harness([use(call("write_file", { path: "x", content: "x" })), say("can't")], { prompter: allow });
    await h.session.run("explain", { mode: "ask" });
    expect(h.provider.requests[0]!.tools!.map((t) => t.name)).not.toContain("write_file");
    expect(h.provider.requests[0]!.tools!.map((t) => t.name)).not.toContain("run_command");
    expect(toolMessages(h)[0]!.content).toMatch(/Unknown tool "write_file"/);
  });
});

describe("agent loop: commands, retries and recovery", () => {
  it("feeds failing command output back to the model, which then fixes and re-runs", async () => {
    const check = nodeCmd("process.exit(require('fs').existsSync('fixed.txt')?0:1)");
    h = harness(
      [
        use(call("run_command", { command: check + " && echo test-ok" })),
        use(call("write_file", { path: "fixed.txt", content: "yes" })),
        use(call("run_command", { command: check + " && echo test-ok" })),
        say("Fixed; the test command now exits 0."),
      ],
      { prompter: allow },
    );
    const r = await h.session.run("make the check pass");
    expect(r.reason).toBe("completed");
    const tm = toolMessages(h).map((m) => m.content);
    expect(tm[0]).toContain("exit code: 1");
    expect(tm[2]).toContain("exit code: 0");
    expect(tm[2]).toContain("test-ok");
    expect(h.events.some((e) => e.type === "agent.state" && e.state === "RECOVERING")).toBe(true);
  });

  it("stops offering tools after maxRetries consecutive failing test runs", async () => {
    const failing = (i: number) => use(call("run_command", { command: `node -e "console.error('FAIL ${i}');process.exit(1)" && echo test` }));
    h = harness([failing(1), failing(2), failing(3), say("Report: tests still fail with FAIL 3.")], { prompter: allow, config: { maxRetries: 2, maxIterations: 20 } });
    const r = await h.session.run("fix tests");
    expect(r.reason).toBe("completed");
    const last = h.provider.requests.at(-1)!;
    expect(last.tools).toBeUndefined();
    expect(last.messages.at(-1)!.content).toMatch(/retry limit reached/i);
    // Protocol order preserved: user notice comes after the tool message.
    expect(last.messages.at(-2)!.role).toBe("tool");
  });

  it("gives up after identical failing calls repeat", async () => {
    const same = () => use(call("read_file", { path: "missing.txt" }));
    h = harness([same(), same(), same(), same(), say("unreachable")], { config: { maxIterations: 20 } });
    const r = await h.session.run("read");
    expect(r.reason).toBe("error");
    expect(r.message).toMatch(/failed 4 times/);
  });

  it("stops at maxIterations", async () => {
    let i = 0;
    h = harness(Array.from({ length: 10 }, () => () => use(call("list_directory", { path: "." }, `l${i++}`))), { config: { maxIterations: 3 } });
    const r = await h.session.run("loop");
    expect(r).toMatchObject({ reason: "max_iterations", steps: 3 });
  });

  it("reports model errors as a failed run", async () => {
    h = harness([() => Promise.reject(new Error("endpoint down"))]);
    const r = await h.session.run("hi");
    expect(r).toMatchObject({ reason: "error", message: "endpoint down" });
    expect(types(h)).toContain("model.error");
  });

  it("nudges once after an empty reply", async () => {
    h = harness([say(""), say("Actually here is the answer.")]);
    const r = await h.session.run("hi");
    expect(r.reason).toBe("completed");
    expect(r.finalText).toContain("answer");
  });
});

describe("agent loop: cancellation", () => {
  it("cancels a running command promptly and records a tool result for it", async () => {
    h = harness([use(call("run_command", { command: nodeCmd("setTimeout(()=>{},60000)") }, "long")), say("unreachable")], { prompter: allow });
    const ctrl = new AbortController();
    const p = h.session.run("sleep", { signal: ctrl.signal });
    const started = Date.now();
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (h!.events.some((e) => e.type === "tool.started")) {
          clearInterval(t);
          resolve();
        }
      }, 20);
    });
    setTimeout(() => ctrl.abort(), 200);
    const r = await p;
    expect(r.reason).toBe("cancelled");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(toolMessages(h)).toHaveLength(1);
    expect(h.events.at(-1)).toMatchObject({ type: "agent.completed", reason: "cancelled" });
    expect(h.provider.requests).toHaveLength(1);
  });

  it("cancels while waiting for permission", async () => {
    h = harness([use(call("write_file", { path: "x", content: "x" })), say("no")], {
      prompter: (_req, signal) => new Promise((_res, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
    });
    const ctrl = new AbortController();
    const p = h.session.run("write", { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 100));
    ctrl.abort();
    expect((await p).reason).toBe("cancelled");
    expect(h.session.changes.list()).toHaveLength(0);
  });

  it("returns cancelled immediately when the signal is already aborted", async () => {
    h = harness([say("never")]);
    const ctrl = new AbortController();
    ctrl.abort();
    expect((await h.session.run("x", { signal: ctrl.signal })).reason).toBe("cancelled");
    expect(h.provider.requests).toHaveLength(0);
  });
});

describe("plan and delegation", () => {
  it("records the plan and emits updates", async () => {
    h = harness([use(call("update_plan", { steps: [{ text: "Inspect", status: "done" }, { text: "Edit", status: "in_progress" }] })), say("ok")]);
    await h.session.run("plan");
    expect(h.session.agent.plan).toEqual([{ text: "Inspect", status: "done" }, { text: "Edit", status: "in_progress" }]);
    expect(h.events.find((e) => e.type === "plan.updated")).toBeTruthy();
  });

  it("delegates to a read-only sub-agent with isolated context and returns its summary", async () => {
    h = harness(
      [
        use(call("delegate_task", { task: "Investigate how a.txt is used" })),
        // sub-agent turn 1: reads a file; turn 2: summary
        use(call("read_file", { path: "a.txt" })),
        say("a.txt contains the word hello."),
        say("Sub-agent says a.txt contains hello."),
      ],
      { setup: (d) => writeFileSync(join(d, "a.txt"), "hello") },
    );
    const r = await h.session.run("investigate");
    expect(r.reason).toBe("completed");
    // Sub-agent request: its own system prompt, only read-only tools, no delegate.
    const subReq = h.provider.requests[1]!;
    expect(subReq.messages[0]!.content).toContain("sub-agent");
    expect(subReq.messages.some((m) => m.content.includes("How are you") )).toBe(false);
    const names = subReq.tools!.map((t) => t.name);
    expect(names).toContain("read_file");
    expect(names).not.toContain("write_file");
    expect(names).not.toContain("delegate_task");
    expect(toolMessages(h)[0]!.content).toContain("a.txt contains the word hello");
    // The parent history does not contain the sub-agent's file read.
    expect(h.session.agent.history.some((m) => m.role === "tool" && m.name === "read_file")).toBe(false);
  });
});
