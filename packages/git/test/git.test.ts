import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Git, formatStatus, parseStatus } from "../src";

let dir: string;
let git: Git;
const sh = (...a: string[]) => execFileSync("git", a, { cwd: dir, stdio: "pipe" });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bc-git-"));
  sh("init", "-b", "main");
  sh("config", "user.email", "t@example.com");
  sh("config", "user.name", "Tester");
  sh("config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "a.txt"), "one\n");
  sh("add", ".");
  sh("commit", "-m", "init");
  git = new Git(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("git", () => {
  it("detects repositories", async () => {
    expect(await git.isRepo()).toBe(true);
    const plain = mkdtempSync(join(tmpdir(), "bc-nogit-"));
    expect(await new Git(plain).isRepo()).toBe(false);
    rmSync(plain, { recursive: true, force: true });
  });

  it("reports status: staged, modified, untracked", async () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    writeFileSync(join(dir, "new.txt"), "n\n");
    sh("add", "new.txt");
    writeFileSync(join(dir, "untracked.txt"), "u\n");
    const s = await git.status();
    expect(s.branch).toBe("main");
    expect(s.staged.map((f) => f.path)).toEqual(["new.txt"]);
    expect(s.modified.map((f) => f.path)).toEqual(["a.txt"]);
    expect(s.untracked).toEqual(["untracked.txt"]);
    expect(s.clean).toBe(false);
    expect(formatStatus(s)).toContain("Untracked");
  });

  it("clean status", async () => {
    expect((await git.status()).clean).toBe(true);
  });

  it("diffs working tree and staged changes", async () => {
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect(await git.diff()).toContain("+two");
    expect(await git.diff({ staged: true })).toBe("");
    await git.add(["a.txt"]);
    expect(await git.diff({ staged: true })).toContain("-one");
    expect(await git.diff({ staged: true, stat: true })).toContain("a.txt");
  });

  it("commits and lists the log", async () => {
    writeFileSync(join(dir, "b.txt"), "b\n");
    await git.add(["b.txt"]);
    const c = await git.commit("add b");
    expect(c.hash).toMatch(/^[0-9a-f]+$/);
    const log = await git.log(5);
    expect(log.map((l) => l.subject)).toEqual(["add b", "init"]);
  });

  it("rejects empty commit messages and nothing-to-commit", async () => {
    await expect(git.commit("  ")).rejects.toThrow(/empty/);
    await expect(git.commit("x")).rejects.toThrow(/git commit failed/);
  });

  it("creates and switches branches", async () => {
    await git.checkout("feature/x", { create: true });
    expect(await git.currentBranch()).toBe("feature/x");
    const branches = await git.branches();
    expect(branches.find((b) => b.current)?.name).toBe("feature/x");
    await git.checkout("main");
    expect(await git.currentBranch()).toBe("main");
  });

  it("rejects option-like refs", async () => {
    await expect(git.checkout("--force")).rejects.toThrow(/Invalid git ref/);
    await expect(git.push({ remote: "--delete" })).rejects.toThrow(/Invalid git ref/);
  });

  it("returns an empty log for a repo without commits", async () => {
    const empty = mkdtempSync(join(tmpdir(), "bc-empty-"));
    execFileSync("git", ["init"], { cwd: empty });
    expect(await new Git(empty).log()).toEqual([]);
    rmSync(empty, { recursive: true, force: true });
  });

  it("parses ahead/behind and renames", () => {
    const s = parseStatus("## main...origin/main [ahead 2, behind 1]\0R  new.txt\0old.txt\0UU conflict.txt\0");
    expect(s).toMatchObject({ branch: "main", upstream: "origin/main", ahead: 2, behind: 1 });
    expect(s.staged[0]).toMatchObject({ path: "new.txt", origPath: "old.txt" });
    expect(s.conflicted[0]!.path).toBe("conflict.txt");
  });
});
