import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { forget, formatMemory, readMemory, remember } from "@betacode/project";
import { commandForTool, mentionedCommands, unverifiedCommandClaims } from "../src";
import { call, harness, nodeCmd, say, use, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(() => h?.cleanup());
const toolMessages = (hh: Harness) => hh.session.agent.history.filter((m) => m.role === "tool");

describe("claim checking", () => {
  it("extracts command-like inline code only", () => {
    expect(mentionedCommands("I ran `npm test` and `git status`, edited `src/a.ts` and used `foo`.")).toEqual(["npm test", "git status"]);
  });

  it("flags commands that were mentioned as run but never executed", () => {
    expect(unverifiedCommandClaims("Ran `npm test` and `git status`: all good.", ["npm test"])).toEqual(["git status"]);
    expect(unverifiedCommandClaims("Ran `npm test`.", ["npm test --silent"])).toEqual([]);
    expect(unverifiedCommandClaims("Ran `npm test`.", [])).toEqual(["npm test"]);
  });

  it("makes no claim-check without an execution claim", () => {
    expect(unverifiedCommandClaims("You can start it with `npm start`.", [])).toEqual([]);
  });

  it("maps git tools to commands", () => {
    expect(commandForTool("git_status", {})).toBe("git status");
    expect(commandForTool("run_command", { command: "pnpm test" })).toBe("pnpm test");
    expect(commandForTool("read_file", {})).toBeUndefined();
  });

  it("makes the agent correct a report that names a command it never ran", async () => {
    h = harness([say("I ran `git status` and everything is clean."), say("I did not run any commands; I only answered from the file listing.")], {});
    const r = await h.session.run("what's here?");
    expect(r.finalText).toMatch(/did not run any commands/);
    const nudge = h.provider.requests[1]!.messages.at(-1)!;
    expect(nudge.role).toBe("user");
    expect(nudge.content).toMatch(/`git status`.*no tool call/s);
  });

  it("leaves honest reports alone and only nudges once", async () => {
    h = harness([use(call("git_status", {})), say("I ran `git status`: not a repository.")], {});
    await h.session.run("status?");
    expect(h.provider.requests).toHaveLength(2);
    h.cleanup();
    h = harness([say("I ran `git status`."), say("Still claiming I ran `git status`.")], {});
    const r = await h.session.run("x");
    expect(r.reason).toBe("completed");
    expect(h.provider.requests).toHaveLength(2);
  });
});

describe("project memory", () => {
  let dir: string;
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

  it("stores, de-duplicates, limits and forgets notes", () => {
    dir = mkdtempSync(join(tmpdir(), "bc-mem-"));
    expect(readMemory(dir)).toEqual([]);
    expect(remember(dir, "Tests run with `pnpm test`")).toMatchObject({ added: true, entries: 1 });
    expect(remember(dir, "tests run with `pnpm  test`")).toMatchObject({ added: false, reason: "duplicate" });
    expect(remember(dir, "   ")).toMatchObject({ added: false, reason: "empty" });
    remember(dir, "x".repeat(500));
    expect(readMemory(dir)[1]!.length).toBe(300);
    expect(readFileSync(join(dir, ".betacode/memory.md"), "utf8")).toContain("- Tests run with `pnpm test`");
    expect(forget(dir, 0)).toBe(true);
    expect(readMemory(dir)).toHaveLength(1);
    expect(forget(dir, 9)).toBe(false);
    for (let i = 0; i < 80; i++) remember(dir, `fact number ${i}`);
    expect(readMemory(dir)).toHaveLength(60);
    expect(formatMemory(["a", "b"])).toBe("- a\n- b");
  });

  it("the agent saves a note only with approval, and the next session's prompt contains it", async () => {
    h = harness([use(call("remember", { note: "Run tests with `npm test` (node --test)." })), say("Saved.")], { prompter: async () => "allow_once" });
    await h.session.run("remember the test command");
    expect(toolMessages(h)[0]!.content).toMatch(/Remembered/);
    expect(readMemory(h.dir)).toEqual(["Run tests with `npm test` (node --test)."]);
    await h.session.run("hello");
    const sys = h.provider.requests.at(-1)!.messages[0]!.content;
    expect(sys).toContain("<project_memory>");
    expect(sys).toContain("Run tests with `npm test`");
  });

  it("denied notes are not saved, and read-only modes cannot save", async () => {
    h = harness([use(call("remember", { note: "Something worth remembering" }))], { prompter: async () => "deny" });
    await h.session.run("x");
    expect(readMemory(h.dir)).toEqual([]);
    h.cleanup();
    h = harness([use(call("remember", { note: "Something worth remembering" })), say("no")], { prompter: async () => "allow_once" });
    await h.session.run("x", { mode: "ask" });
    expect(toolMessages(h)[0]!.content).toMatch(/Unknown tool "remember"/);
    writeFileSync(join(h.dir, "keep"), "");
  });
});

void nodeCmd;
