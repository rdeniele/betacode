import { describe, expect, it } from "vitest";
import { LineEditor } from "./line-editor";

const submits = (a: ReturnType<LineEditor["feed"]>) => a.filter((x) => x.type === "submit").map((x) => (x as { command: string }).command);

describe("LineEditor", () => {
  it("echoes typed characters and submits a trimmed command on Enter", () => {
    const e = new LineEditor();
    const a = e.feed("npm test\r");
    expect(a.filter((x) => x.type === "write").map((x) => (x as { text: string }).text).join("")).toContain("npm test");
    expect(submits(a)).toEqual(["npm test"]);
    expect(e.line).toBe("");
  });

  it("handles backspace", () => {
    const e = new LineEditor();
    e.feed("lss");
    e.feed("\x7f");
    expect(submits(e.feed("\r"))).toEqual(["ls"]);
  });

  it("ignores blank lines and recalls history with arrow keys", () => {
    const e = new LineEditor();
    expect(submits(e.feed("\r"))).toEqual([]);
    e.feed("git status\r");
    e.feed("ls\r");
    e.feed("\x1b[A");
    expect(e.line).toBe("ls");
    e.feed("\x1b[A");
    expect(e.line).toBe("git status");
    e.feed("\x1b[B");
    expect(e.line).toBe("ls");
    e.feed("\x1b[B");
    expect(e.line).toBe("");
  });

  it("Ctrl+C interrupts a running command, otherwise clears the line", () => {
    const e = new LineEditor();
    e.feed("abc");
    e.feed("\x03");
    expect(e.line).toBe("");
    e.busy = true;
    expect(e.feed("\x03")).toEqual([{ type: "interrupt" }]);
  });

  it("drops input while a command is running", () => {
    const e = new LineEditor();
    e.busy = true;
    expect(e.feed("hello\r")).toEqual([]);
    expect(e.line).toBe("");
  });

  it("handles pasted multi-character chunks", () => {
    const e = new LineEditor();
    expect(submits(e.feed("echo hi\recho there\r"))).toEqual(["echo hi", "echo there"]);
  });
});
