import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeTracker, FileService, Workspace, looseReplace } from "../src";

describe("looseReplace", () => {
  const file = "def f():\n    if x:\n        run()\n    return 1\n";

  it("matches ignoring indentation and re-indents the replacement", () => {
    const out = looseReplace(file, "if x:\n    run()", "if x:\n    run()\n    log()");
    expect(out).toBe("def f():\n    if x:\n        run()\n        log()\n    return 1\n");
  });

  it("ignores blank lines at the ends of oldText", () => {
    expect(looseReplace(file, "\n  return 1\n\n", "  return 2")).toBe("def f():\n    if x:\n        run()\n    return 2\n");
  });

  it("returns undefined when nothing matches and 'ambiguous' for repeated blocks", () => {
    expect(looseReplace(file, "return 3", "x")).toBeUndefined();
    expect(looseReplace("  a\nb\n    a\nb\n", "a\nb", "x")).toBe("ambiguous");
  });

  it("preserves CRLF line endings", () => {
    expect(looseReplace("a\r\n  b\r\nc\r\n", "b", "B")).toBe("a\r\n  B\r\nc\r\n");
  });
});

describe("requireReadBeforeEdit", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const make = (strict: boolean) => {
    dir = mkdtempSync(join(tmpdir(), "bc-rbe-"));
    writeFileSync(join(dir, "a.txt"), "one\n");
    const ws = new Workspace(dir);
    return new FileService(ws, new ChangeTracker(ws), { requireReadBeforeEdit: strict });
  };

  it("is off by default and on when requested", () => {
    expect(() => make(false).edit("a.txt", "one", "two")).not.toThrow();
    const fs = make(true);
    expect(() => fs.edit("a.txt", "one", "two")).toThrow(/have not read a\.txt/);
    fs.read("a.txt");
    expect(fs.edit("a.txt", "one", "two").replacements).toBe(1);
  });

  it("a partial read counts, and writes by the agent keep the file fresh", () => {
    const fs = make(true);
    fs.read("a.txt", { offset: 1, limit: 1 });
    fs.edit("a.txt", "one", "two");
    expect(() => fs.edit("a.txt", "two", "three")).not.toThrow();
    expect(() => fs.write("a.txt", "four\n")).not.toThrow();
  });
});
