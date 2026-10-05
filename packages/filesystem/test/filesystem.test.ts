import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChangeTracker, FileService, PathEscapeError, Workspace, findFiles, hasRipgrep, isSensitivePath, renderTree, searchText } from "../src";

let dir: string;
let outside: string;
let fs: FileService;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bc-fs-"));
  outside = mkdtempSync(join(tmpdir(), "bc-out-"));
  writeFileSync(join(outside, "secret.txt"), "TOP SECRET");
  mkdirSync(join(dir, "src"));
  mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\nexport const b = 2;\n");
  writeFileSync(join(dir, "src/b.ts"), "import { a } from './a';\nconsole.log(a);\n");
  writeFileSync(join(dir, "node_modules/pkg/index.js"), "export const a = 'ignored';\n");
  writeFileSync(join(dir, ".gitignore"), "secret-dir/\n*.log\n");
  writeFileSync(join(dir, "debug.log"), "a log with a in it");
  writeFileSync(join(dir, ".env"), "API_KEY=abc123");
  const ws = new Workspace(dir);
  fs = new FileService(ws, new ChangeTracker(ws));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

describe("workspace boundary", () => {
  it.each(["../x", "../../etc/passwd", "src/../../x", "..\\..\\x"])("blocks traversal %s", (p) => {
    expect(() => fs.ws.resolve(p)).toThrow(PathEscapeError);
  });

  it("blocks absolute paths outside the workspace", () => {
    expect(() => fs.ws.resolve(join(outside, "secret.txt"))).toThrow(PathEscapeError);
  });

  it("allows absolute paths inside the workspace", () => {
    expect(fs.ws.rel(fs.ws.resolve(join(dir, "src", "a.ts")))).toBe("src/a.ts");
  });

  it("blocks null bytes", () => {
    expect(() => fs.ws.resolve("a\0b")).toThrow(PathEscapeError);
  });

  it("blocks symlinks that point outside", () => {
    try {
      symlinkSync(outside, join(dir, "link"), "junction");
    } catch {
      return; // cannot create links in this environment
    }
    expect(() => fs.read("link/secret.txt")).toThrow(PathEscapeError);
    expect(() => fs.write("link/new.txt", "x")).toThrow(PathEscapeError);
  });

  it("flags sensitive paths", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("config/.env.production")).toBe(true);
    expect(isSensitivePath(".env.example")).toBe(false);
    expect(isSensitivePath("home/.ssh/id_rsa")).toBe(true);
    expect(isSensitivePath("src/a.ts")).toBe(false);
  });
});

describe("read", () => {
  it("returns numbered lines, size and language", () => {
    const r = fs.read("src/a.ts");
    expect(r.numbered).toBe("1\texport const a = 1;\n2\texport const b = 2;");
    expect(r).toMatchObject({ language: "typescript", totalLines: 2, truncated: false });
    expect(r.size).toBeGreaterThan(0);
  });

  it("supports offset and limit", () => {
    const r = fs.read("src/a.ts", { offset: 2, limit: 1 });
    expect(r.text).toBe("export const b = 2;");
    expect(r.startLine).toBe(2);
  });

  it("refuses .env unless allowed", () => {
    expect(() => fs.read(".env")).toThrow(/secrets/);
    expect(fs.read(".env", { allowSensitive: true }).text).toBe("API_KEY=abc123");
  });

  it("errors for missing files, directories and binaries", () => {
    expect(() => fs.read("nope.ts")).toThrow(/not found/i);
    expect(() => fs.read("src")).toThrow(/directory/);
    writeFileSync(join(dir, "bin.dat"), Buffer.from([1, 2, 0, 3]));
    expect(() => fs.read("bin.dat")).toThrow(/binary/);
  });
});

describe("write / edit / delete", () => {
  it("creates files and parent directories, tracking the change", () => {
    const r = fs.write("src/new/deep.ts", "x\n");
    expect(r.kind).toBe("added");
    expect(readFileSync(join(dir, "src/new/deep.ts"), "utf8")).toBe("x\n");
    expect(fs.changes.list()).toHaveLength(1);
    expect(fs.changes.toInfo(fs.changes.list()[0]!)).toMatchObject({ kind: "added", additions: 1 });
  });

  it("edits with exact match and produces a diff", () => {
    const r = fs.edit("src/a.ts", "a = 1", "a = 42");
    expect(r.diff).toContain("-export const a = 1;");
    expect(r.diff).toContain("+export const a = 42;");
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("a = 42");
  });

  it("fails when oldText is missing so the model can re-read", () => {
    expect(() => fs.edit("src/a.ts", "does not exist", "x")).toThrow(/not found in src\/a.ts/);
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("a = 1");
    expect(fs.changes.list()).toHaveLength(0);
  });

  it("rejects ambiguous matches unless replaceAll", () => {
    expect(() => fs.edit("src/a.ts", "export const", "const")).toThrow(/2 places/);
    const r = fs.edit("src/a.ts", "export const", "const", true);
    expect(r.replacements).toBe(2);
  });

  it("matches across CRLF line endings", () => {
    writeFileSync(join(dir, "crlf.txt"), "one\r\ntwo\r\nthree\r\n");
    fs.edit("crlf.txt", "one\ntwo", "1\n2");
    expect(readFileSync(join(dir, "crlf.txt"), "utf8")).toBe("1\r\n2\r\nthree\r\n");
  });

  it("deletes files and tracks it", () => {
    fs.delete("src/b.ts");
    expect(existsSync(join(dir, "src/b.ts"))).toBe(false);
    expect(fs.changes.toInfo(fs.changes.list()[0]!).kind).toBe("deleted");
  });

  it("requires recursive for directories and never deletes the root", () => {
    expect(() => fs.delete("src")).toThrow(/recursive/);
    expect(() => fs.delete(".", { recursive: true })).toThrow(/root/);
    fs.delete("src", { recursive: true });
    expect(existsSync(join(dir, "src"))).toBe(false);
    expect(fs.changes.list()).toHaveLength(2);
  });

  it("moves and copies files", () => {
    fs.move("src/b.ts", "lib/b.ts");
    expect(existsSync(join(dir, "lib/b.ts"))).toBe(true);
    fs.copy("lib/b.ts", "lib/c.ts");
    expect(existsSync(join(dir, "lib/c.ts"))).toBe(true);
    expect(() => fs.copy("lib/b.ts", "lib/c.ts")).toThrow(/exists/);
  });
});

describe("change tracking", () => {
  it("coalesces edits and reverts to the original", () => {
    fs.edit("src/a.ts", "a = 1", "a = 2");
    fs.edit("src/a.ts", "a = 2", "a = 3");
    expect(fs.changes.list()).toHaveLength(1);
    fs.changes.revert(fs.changes.list()[0]!.id);
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toBe("export const a = 1;\nexport const b = 2;\n");
  });

  it("revert removes added files and restores deleted ones", () => {
    fs.write("new.ts", "n");
    fs.delete("src/b.ts");
    for (const c of fs.changes.list()) fs.changes.revert(c.id);
    expect(existsSync(join(dir, "new.ts"))).toBe(false);
    expect(existsSync(join(dir, "src/b.ts"))).toBe(true);
  });

  it("refuses to revert over later manual edits unless forced", () => {
    fs.edit("src/a.ts", "a = 1", "a = 2");
    writeFileSync(join(dir, "src/a.ts"), "user edit");
    const id = fs.changes.list()[0]!.id;
    expect(() => fs.changes.revert(id)).toThrow(/modified after/);
    fs.changes.revert(id, true);
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("a = 1");
  });

  it("supports undo and redo", () => {
    fs.edit("src/a.ts", "a = 1", "a = 9");
    fs.changes.undo();
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("a = 1");
    fs.changes.redo();
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("a = 9");
  });

  it("accept keeps the file and marks status", () => {
    fs.edit("src/a.ts", "a = 1", "a = 5");
    const c = fs.changes.accept(fs.changes.list()[0]!.id);
    expect(c.status).toBe("accepted");
    expect(readFileSync(join(dir, "src/a.ts"), "utf8")).toContain("a = 5");
  });
});

describe("listing and search", () => {
  it("respects ignore rules", () => {
    const tree = renderTree(fs.list(".", { depth: 3 }));
    expect(tree).toContain("src/");
    expect(tree).toContain("a.ts");
    expect(tree).not.toContain("node_modules");
    expect(tree).not.toContain("debug.log");
  });

  for (const engine of ["builtin", "ripgrep"] as const) {
    it(`finds text with ${engine}`, async () => {
      if (engine === "ripgrep" && !hasRipgrep()) return;
      const r = await searchText(fs, { query: "console.log", useRipgrep: engine === "ripgrep" });
      expect(r.matches.map((m) => `${m.path}:${m.line}`)).toEqual(["src/b.ts:2"]);
    });

    it(`ignores node_modules, .env and gitignored files with ${engine}`, async () => {
      if (engine === "ripgrep" && !hasRipgrep()) return;
      const r = await searchText(fs, { query: "a", useRipgrep: engine === "ripgrep", glob: "*" });
      const paths = new Set(r.matches.map((m) => m.path));
      expect(paths.has("src/a.ts")).toBe(true);
      expect(paths.has("node_modules/pkg/index.js")).toBe(false);
      expect(paths.has("debug.log")).toBe(false);
      expect(paths.has(".env")).toBe(false);
    });

    it(`supports regex, glob and context with ${engine}`, async () => {
      if (engine === "ripgrep" && !hasRipgrep()) return;
      const r = await searchText(fs, { query: "const\\s+b", regex: true, glob: "*.ts", context: 1, useRipgrep: engine === "ripgrep" });
      expect(r.matches).toHaveLength(1);
      expect(r.matches[0]).toMatchObject({ path: "src/a.ts", line: 2 });
      expect(r.matches[0]!.before?.[0]?.text).toContain("a = 1");
    });
  }

  it("rejects invalid regex and searches outside the workspace", async () => {
    await expect(searchText(fs, { query: "(", regex: true })).rejects.toThrow(/Invalid regular expression/);
    await expect(searchText(fs, { query: "x", path: "../" })).rejects.toBeInstanceOf(PathEscapeError);
  });

  it("finds files by glob and substring", () => {
    expect(findFiles(fs, "*.ts").files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(findFiles(fs, "src/**/*.ts").files).toEqual(["src/a.ts", "src/b.ts"]);
    expect(findFiles(fs, "b.t").files).toEqual(["src/b.ts"]);
  });
});
