import { describe, expect, it } from "vitest";
import type { PermissionDecision, PermissionRequest } from "@betacode/shared";
import { createDefaultRegistry } from "@betacode/tools";
import { MemoryRuleStore, PermissionManager } from "../src";

const reg = createDefaultRegistry();
const sig = new AbortController().signal;
const write = reg.get("write_file")!;
const del = reg.get("delete_file")!;
const run = reg.get("run_command")!;
const read = reg.get("read_file")!;

function mgr(decision: PermissionDecision | (() => PermissionDecision), extra: ConstructorParameters<typeof PermissionManager>[0] = {}) {
  const asked: PermissionRequest[] = [];
  const m = new PermissionManager({
    prompter: async (r) => (asked.push(r), typeof decision === "function" ? decision() : decision),
    rules: new MemoryRuleStore(),
    ...extra,
  });
  return { m, asked };
}

describe("PermissionManager", () => {
  it("safe: allowed without asking", async () => {
    const { m, asked } = mgr("deny");
    expect(await m.check(read, { level: "safe", summary: "read" }, sig)).toEqual({ allowed: true });
    expect(asked).toHaveLength(0);
  });

  it("confirm: asks, allow_once does not stick", async () => {
    const { m, asked } = mgr("allow_once");
    const a = { level: "confirm" as const, summary: "Edit x" };
    expect((await m.check(write, a, sig)).allowed).toBe(true);
    expect((await m.check(write, a, sig)).allowed).toBe(true);
    expect(asked).toHaveLength(2);
  });

  it("confirm: allow_session sticks for the session only", async () => {
    const { m, asked } = mgr("allow_session");
    const a = { level: "confirm" as const, summary: "Edit x" };
    await m.check(write, a, sig);
    await m.check(write, a, sig);
    expect(asked).toHaveLength(1);
    m.clearSessionGrants();
    await m.check(write, a, sig);
    expect(asked).toHaveLength(2);
  });

  it("deny returns a message instructing the model not to retry", async () => {
    const { m } = mgr("deny");
    const r = await m.check(write, { level: "confirm", summary: "Edit x" }, sig);
    expect(r).toMatchObject({ allowed: false, denied: true });
    expect(r.message).toMatch(/Do not retry/);
  });

  it("dangerous: always asks; allow_session only covers the exact same action", async () => {
    const { m, asked } = mgr("allow_session");
    await m.check(del, { level: "dangerous", summary: "Delete a" }, sig);
    await m.check(del, { level: "dangerous", summary: "Delete a" }, sig);
    expect(asked).toHaveLength(1);
    await m.check(del, { level: "dangerous", summary: "Delete b" }, sig);
    expect(asked).toHaveLength(2);
    expect(asked[1]!.riskLevel).toBe("dangerous");
  });

  it("always_allow persists for confirm-level but never covers dangerous", async () => {
    const rules = new MemoryRuleStore();
    const { m, asked } = mgr("always_allow", { rules });
    await m.check(write, { level: "confirm", summary: "Edit x" }, sig);
    await m.check(write, { level: "confirm", summary: "Edit y" }, sig);
    expect(asked).toHaveLength(1);
    expect(rules.list()).toEqual([{ tool: "write_file", decision: "allow" }]);

    await m.check(run, { level: "dangerous", summary: "rm -rf a", grantKey: "run_command:rm -rf a" }, sig);
    expect(rules.list().some((r) => r.tool === "run_command")).toBe(false);
    await m.check(run, { level: "dangerous", summary: "rm -rf b", grantKey: "run_command:rm -rf b" }, sig);
    expect(asked).toHaveLength(3);
  });

  it("always_deny blocks later calls without asking", async () => {
    const { m, asked } = mgr("always_deny");
    await m.check(write, { level: "confirm", summary: "Edit x" }, sig);
    const r = await m.check(write, { level: "confirm", summary: "Edit y" }, sig);
    expect(r.allowed).toBe(false);
    expect(asked).toHaveLength(1);
  });

  it("config overrides can relax file tools, block tools, but never relax dangerous commands", async () => {
    const { m, asked } = mgr("deny", { overrides: { write_file: "safe", delete_file: "deny", run_command: "safe" } });
    expect((await m.check(write, { level: "confirm", summary: "w" }, sig)).allowed).toBe(true);
    expect((await m.check(del, { level: "dangerous", summary: "d" }, sig)).allowed).toBe(false);
    expect((await m.check(run, { level: "dangerous", summary: "sudo x" }, sig)).allowed).toBe(false);
    expect(asked.map((a) => a.tool)).toEqual(["run_command"]);
  });

  it("denies when no prompter exists", async () => {
    const m = new PermissionManager();
    const r = await m.check(write, { level: "confirm", summary: "Edit x" }, sig);
    expect(r.allowed).toBe(false);
    expect(r.message).toMatch(/no interactive approval/);
  });

  it("treats prompter failures and aborts as denial", async () => {
    const m = new PermissionManager({ prompter: async () => Promise.reject(new Error("ui crashed")) });
    expect((await m.check(write, { level: "confirm", summary: "x" }, sig)).allowed).toBe(false);
    const ctrl = new AbortController();
    const m2 = new PermissionManager({ prompter: async () => (ctrl.abort(), "allow_once") });
    expect((await m2.check(write, { level: "confirm", summary: "x" }, ctrl.signal)).allowed).toBe(false);
  });

  it("emits requested/resolved events", async () => {
    const events: string[] = [];
    const m = new PermissionManager({ prompter: async () => "allow_once", emit: (e) => events.push(e.type) });
    await m.check(write, { level: "confirm", summary: "x" }, sig);
    expect(events).toEqual(["permission.requested", "permission.resolved"]);
  });
});
