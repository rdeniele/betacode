import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Database } from "../src";

let dir: string;
let db: Database;
let projectId: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "bc-db-"));
  db = await Database.open(join(dir, "nested", "test.db"));
  projectId = (await db.upsertProject("/work/app", "app", { frameworks: ["Next.js"] })).id;
});
afterAll(async () => {
  await db.close();
  rmSync(dir, { recursive: true, force: true });
});

const mk = (title: string) => db.createSession({ projectId, title, provider: "qwen", model: "Qwen/Qwen3-Coder-30B-A3B-Instruct" });

describe("Database", () => {
  it("upserts projects idempotently", async () => {
    const again = await db.upsertProject("/work/app", "app2");
    expect(again.id).toBe(projectId);
    expect((await db.listProjects()).filter((p) => p.path === "/work/app")).toHaveLength(1);
    expect((await db.listProjects())[0]!.metadata).toEqual({ frameworks: ["Next.js"] });
  });

  it("persists and restores messages including tool calls, in order", async () => {
    const s = await mk("msgs");
    await db.appendMessage(s.id, { role: "user", content: "hi" });
    await db.appendMessage(s.id, { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }] });
    await db.appendMessage(s.id, { role: "tool", content: "file", toolCallId: "c1", name: "read_file" });
    await db.appendMessage(s.id, { role: "assistant", content: "done" });
    const msgs = await db.loadMessages(s.id);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(msgs[1]!.toolCalls).toEqual([{ id: "c1", name: "read_file", arguments: '{"path":"a"}' }]);
    expect(msgs[2]).toMatchObject({ toolCallId: "c1", name: "read_file" });
  });

  it("renames, searches, duplicates and deletes sessions", async () => {
    const a = await mk("Fix authentication");
    const b = await mk("Build dashboard");
    await db.appendMessage(b.id, { role: "user", content: "please use recharts" });
    await db.renameSession(a.id, "Fix login bug");
    expect((await db.getSession(a.id))!.title).toBe("Fix login bug");
    expect((await db.listSessions(projectId, "login")).map((s) => s.id)).toEqual([a.id]);
    expect((await db.listSessions(projectId, "recharts")).map((s) => s.id)).toEqual([b.id]);

    const copy = await db.duplicateSession(b.id);
    expect(copy.title).toBe("Build dashboard (copy)");
    expect(await db.loadMessages(copy.id)).toHaveLength(1);

    await db.deleteSession(b.id);
    expect(await db.getSession(b.id)).toBeUndefined();
    expect(await db.loadMessages(b.id)).toEqual([]); // cascaded
    expect(await db.getSession(copy.id)).toBeDefined();
  });

  it("stores compaction state, plan and usage", async () => {
    const s = await mk("state");
    await db.saveSessionState(s.id, { summary: "Task: x", foldedCount: 12, plan: [{ text: "a", status: "done" }], addUsage: { inputTokens: 100, outputTokens: 10 } });
    await db.saveSessionState(s.id, { addUsage: { inputTokens: 50, outputTokens: 5 } });
    const r = (await db.getSession(s.id))!;
    expect(r).toMatchObject({ summary: "Task: x", foldedCount: 12, inputTokens: 150, outputTokens: 15 });
    expect(r.plan).toEqual([{ text: "a", status: "done" }]);
  });

  it("records tool calls with secrets redacted", async () => {
    const s = await mk("tools");
    const id = await db.recordToolStart(s.id, "c1", "run_command", { command: "echo OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz" });
    await db.recordToolEnd(id, { ok: true, content: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789", durationMs: 12 });
    const [tc] = await db.listToolCalls(s.id);
    expect(tc).toMatchObject({ name: "run_command", ok: true, durationMs: 12 });
    expect(tc!.args).not.toContain("sk-abcdefghijklmnopqrstuvwxyz");
    expect(tc!.result).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("tracks file changes and updates them in place", async () => {
    const s = await mk("changes");
    await db.upsertFileChange(s.id, { id: "fc1", path: "a.ts", before: "1", after: "2", status: "pending", turn: 1 });
    await db.upsertFileChange(s.id, { id: "fc1", path: "a.ts", before: "1", after: "3", status: "accepted", turn: 2 });
    const list = await db.listFileChanges(s.id);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ before: "1", after: "3", status: "accepted", turn: 2 });
  });

  it("stores permission rules per scope and preferences", async () => {
    await db.setRule("/work/app", "write_file", "allow");
    await db.setRule("global", "delete_file", "deny");
    await db.setRule("/other", "run_command", "allow");
    expect((await db.listRules("/work/app")).sort((a, b) => a.tool.localeCompare(b.tool))).toEqual([
      { tool: "delete_file", decision: "deny" },
      { tool: "write_file", decision: "allow" },
    ]);
    await db.setRule("/work/app", "write_file", "deny");
    expect((await db.listRules("/work/app")).find((r) => r.tool === "write_file")!.decision).toBe("deny");
    await db.setPreference("theme", "dark");
    await db.setPreference("theme", "light");
    expect(await db.getPreference("theme")).toBe("light");
    expect(await db.getPreference("nope")).toBeUndefined();
  });

  it("reopens an existing database without recreating tables", async () => {
    const s = await mk("persist");
    await db.close();
    db = await Database.open(join(dir, "nested", "test.db"));
    expect((await db.getSession(s.id))!.title).toBe("persist");
  });
});
