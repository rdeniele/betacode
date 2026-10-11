import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stripThinking } from "../src";
import { call, harness, nodeCmd, say, use, type Harness } from "./helpers";

let h: Harness | undefined;
afterEach(() => h?.cleanup());
const toolMessages = (hh: Harness) => hh.session.agent.history.filter((m) => m.role === "tool");
const withProject = (extra: (d: string) => void = () => {}) => (d: string) => {
  writeFileSync(join(d, "package.json"), JSON.stringify({ name: "p", scripts: { test: "node -e \"process.exit(0)\"" } }));
  writeFileSync(join(d, "a.txt"), "hello\n");
  extra(d);
};
const checkCmd = `${nodeCmd("process.exit(0)")} && echo test`;

describe("read before edit", () => {
  it("refuses to edit or overwrite a file the agent has not read, leaving it untouched", async () => {
    h = harness([use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" })), use(call("write_file", { path: "a.txt", content: "x" })), say("ok")], { prompter: async () => "allow_once", setup: withProject() });
    await h.session.run("edit");
    expect(toolMessages(h)[0]!.content).toMatch(/not read a\.txt|have not read a\.txt/);
    expect(toolMessages(h)[1]!.content).toMatch(/have not read a\.txt/);
    expect(readFileSync(join(h.dir, "a.txt"), "utf8")).toBe("hello\n");
  });

  it("allows the edit once the file was read, and a second edit without re-reading", async () => {
    h = harness(
      [
        use(call("read_file", { path: "a.txt" })),
        use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" })),
        use(call("edit_file", { path: "a.txt", oldText: "bye", newText: "ciao" })),
        say("done"),
      ],
      { prompter: async () => "allow_once", setup: withProject() },
    );
    await h.session.run("edit");
    expect(readFileSync(join(h.dir, "a.txt"), "utf8")).toBe("ciao\n");
  });

  it("detects a file that changed after it was read", async () => {
    h = harness(
      [
        use(call("read_file", { path: "a.txt" })),
        () => {
          writeFileSync(join(h!.dir, "a.txt"), "someone else changed this\n");
          const t = new Date(Date.now() + 5000);
          utimesSync(join(h!.dir, "a.txt"), t, t);
          return use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" }));
        },
        say("ok"),
      ],
      { prompter: async () => "allow_once", setup: withProject() },
    );
    await h.session.run("edit");
    expect(toolMessages(h)[1]!.content).toMatch(/changed on disk since you read it/);
    expect(readFileSync(join(h.dir, "a.txt"), "utf8")).toBe("someone else changed this\n");
  });

  it("creating a new file never needs a read", async () => {
    h = harness([use(call("write_file", { path: "new.txt", content: "x" })), say("ok")], { prompter: async () => "allow_once", setup: withProject() });
    await h.session.run("create");
    expect(readFileSync(join(h.dir, "new.txt"), "utf8")).toBe("x");
  });
});

describe("tolerant edits and instant syntax feedback", () => {
  it("applies an edit whose oldText has the wrong indentation, and says so", async () => {
    h = harness(
      [use(call("read_file", { path: "f.js" })), use(call("edit_file", { path: "f.js", oldText: "if (x) {\n  run();\n}", newText: "if (x) {\n  run();\n  log();\n}" })), say("ok")],
      { prompter: async () => "allow_once", setup: withProject((d) => writeFileSync(join(d, "f.js"), "function f(x) {\n    if (x) {\n      run();\n    }\n}\n")) },
    );
    await h.session.run("edit");
    const out = toolMessages(h)[1]!.content;
    expect(out).toMatch(/ignoring indentation/);
    expect(readFileSync(join(h.dir, "f.js"), "utf8")).toBe("function f(x) {\n    if (x) {\n      run();\n      log();\n    }\n}\n");
  });

  it("reports a syntax error in the file it just wrote", async () => {
    h = harness([use(call("write_file", { path: "bad.js", content: "function (" })), use(call("write_file", { path: "ok.js", content: "const a = 1;\n" })), use(call("write_file", { path: "bad.json", content: "{ nope" })), say("done")], {
      prompter: async () => "allow_once",
      setup: withProject(),
    });
    await h.session.run("write");
    expect(toolMessages(h)[0]!.content).toMatch(/Syntax check FAILED for bad\.js/);
    expect(toolMessages(h)[1]!.content).not.toMatch(/Syntax check/);
    expect(toolMessages(h)[2]!.content).toMatch(/Syntax check FAILED for bad\.json/);
  });
});

describe("verification gate", () => {
  it("reminds the agent to run a check before it can finish after editing", async () => {
    h = harness(
      [
        use(call("read_file", { path: "a.txt" })),
        use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" })),
        say("All done!"),
        use(call("run_command", { command: checkCmd })),
        say("Edited a.txt and ran the check: it passed."),
      ],
      { prompter: async () => "allow_once", setup: withProject() },
    );
    const r = await h.session.run("edit");
    expect(r).toMatchObject({ reason: "completed", finalText: "Edited a.txt and ran the check: it passed." });
    const reminder = h.provider.requests[3]!.messages.at(-1)!;
    expect(reminder.role).toBe("user");
    expect(reminder.content).toMatch(/have not run a check/);
    expect(reminder.content).toContain("npm test");
  });

  it("does not nag when a check already ran after the last edit, in ask mode, or when nothing can be run", async () => {
    h = harness([use(call("read_file", { path: "a.txt" })), use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" })), use(call("run_command", { command: checkCmd })), say("done")], { prompter: async () => "allow_once", setup: withProject() });
    await h.session.run("edit");
    expect(h.provider.requests).toHaveLength(4);
    h.cleanup();

    h = harness([use(call("read_file", { path: "a.txt" })), use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" })), say("done")], { prompter: async () => "allow_once", setup: (d) => writeFileSync(join(d, "a.txt"), "hello\n") });
    await h.session.run("edit");
    expect(h.provider.requests).toHaveLength(3); // no package.json → no detected commands → no reminder
  });

  it("nags only once", async () => {
    h = harness([use(call("read_file", { path: "a.txt" })), use(call("edit_file", { path: "a.txt", oldText: "hello", newText: "bye" })), say("done"), say("really done")], { prompter: async () => "allow_once", setup: withProject() });
    const r = await h.session.run("edit");
    expect(r.finalText).toBe("really done");
    expect(h.provider.requests).toHaveLength(4);
  });
});

describe("parallel read-only calls", () => {
  it("answers several independent reads in order, concurrently", async () => {
    h = harness([use(call("read_file", { path: "a.txt" }, "p1"), call("list_directory", {}, "p2"), call("find_files", { pattern: "*.txt" }, "p3")), say("ok")], { setup: withProject() });
    await h.session.run("look");
    expect(toolMessages(h).map((m) => m.toolCallId)).toEqual(["p1", "p2", "p3"]);
    expect(toolMessages(h)[0]!.content).toContain("hello");
  });
});

describe("prompt quality and server problems", () => {
  it("gives the model the project tree, detected commands, date and BETACODE.md up front", async () => {
    h = harness([say("hi")], {
      setup: withProject((d) => {
        mkdirSync(join(d, "src"));
        writeFileSync(join(d, "src", "main.ts"), "export {}");
        writeFileSync(join(d, "BETACODE.md"), "Always use tabs.");
      }),
    });
    await h.session.run("hi");
    const sys = h.provider.requests[0]!.messages[0]!.content;
    expect(sys).toContain("<project_tree>");
    expect(sys).toMatch(/src\/\n\s+main\.ts/);
    expect(sys).toContain("test: npm test");
    expect(sys).toContain("Always use tabs.");
    expect(sys).toMatch(/Today's date: \d{4}-\d{2}-\d{2}/);
  });

  it("refuses to start dev servers in the foreground", async () => {
    h = harness([use(call("run_command", { command: "npm run dev" })), say("ok")], { prompter: async () => "allow_once", setup: withProject() });
    await h.session.run("start it");
    expect(toolMessages(h)[0]!.content).toMatch(/long-running server or watcher/);
  });

  it("warns when the server reads far fewer tokens than were sent (silent truncation)", async () => {
    const big = "x".repeat(40_000);
    h = harness([() => ({ content: "ok", toolCalls: [], finishReason: "stop", usage: { inputTokens: 2048, outputTokens: 2 } })], { setup: withProject((d) => writeFileSync(join(d, "BETACODE.md"), big)) });
    await h.session.run("hi");
    const notice = h.events.find((e) => e.type === "agent.notice");
    expect(notice).toMatchObject({ level: "warn" });
    expect((notice as { message: string }).message).toMatch(/OLLAMA_CONTEXT_LENGTH/);
  });

  it("strips inline reasoning blocks from what is kept in history", async () => {
    expect(stripThinking("<think>plan the work</think>\nAnswer")).toBe("Answer");
    expect(stripThinking("<think>cut off")).toBe("");
    expect(stripThinking("no tags")).toBe("no tags");
    h = harness([say("<think>hidden</think>Visible answer")], { setup: withProject() });
    const r = await h.session.run("q");
    expect(r.finalText).toBe("Visible answer");
    expect(JSON.stringify(h.session.agent.history)).not.toContain("hidden");
  });
});
