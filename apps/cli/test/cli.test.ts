import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UsageError, parseArgs } from "../src/args";
import { runCli, type CliIO } from "../src/cli";
import { Renderer, colorDiff, makeStyle, parsePermissionAnswer } from "../src/render";

describe("parseArgs", () => {
  it("parses chat defaults and flags", () => {
    expect(parseArgs([])).toMatchObject({ command: "chat", continue: false, yes: false });
    const a = parseArgs(["./proj", "--model", "m1", "--provider=openai-compatible", "--base-url", "http://x/v1", "--mode", "plan", "-c", "-y", "-p", "do it"]);
    expect(a).toMatchObject({ command: "chat", path: "./proj", model: "m1", provider: "openai-compatible", baseUrl: "http://x/v1", mode: "plan", continue: true, yes: true, prompt: "do it" });
  });
  it("parses subcommands", () => {
    expect(parseArgs(["doctor", "./p"])).toMatchObject({ command: "doctor", path: "./p" });
    expect(parseArgs(["config", "set", "temperature", "0.2"])).toMatchObject({ command: "config", rest: ["set", "temperature", "0.2"] });
    expect(parseArgs(["init"]).command).toBe("init");
    expect(parseArgs(["--help"]).command).toBe("help");
  });
  it("rejects bad input", () => {
    expect(() => parseArgs(["--mode", "turbo"])).toThrow(UsageError);
    expect(() => parseArgs(["--model"])).toThrow(/requires a value/);
    expect(() => parseArgs(["--nope"])).toThrow(/Unknown option/);
  });
});

describe("Renderer", () => {
  const style = makeStyle(false);
  it("renders streaming text, tools, changes and completion", () => {
    let out = "";
    const r = new Renderer((s) => (out += s), style);
    r.handle({ type: "agent.text", delta: "Looking " });
    r.handle({ type: "agent.text", delta: "around." });
    r.handle({ type: "tool.started", callId: "1", name: "read_file", args: { path: "src/a.ts" } });
    r.handle({ type: "tool.completed", callId: "1", name: "read_file", ok: true, content: "x", durationMs: 4 });
    r.handle({ type: "tool.started", callId: "2", name: "run_command", args: { command: "npm test" } });
    r.handle({ type: "tool.completed", callId: "2", name: "run_command", ok: false, content: "Error: boom\nmore", durationMs: 90 });
    r.handle({ type: "file.changed", change: { id: "c", path: "src/a.ts", kind: "modified", status: "pending", turn: 1, additions: 2, deletions: 1, diff: "" } });
    r.handle({ type: "agent.completed", reason: "completed" });
    expect(out).toContain("Looking around.");
    expect(out).toContain("▸ read_file src/a.ts");
    expect(out).toContain("✗ 90ms Error: boom");
    expect(out).toContain("M src/a.ts +2 -1");
    expect(out).toContain("● Completed");
  });
  it("describes permission requests, including diffs and the dangerous variant", () => {
    const r = new Renderer(() => {}, style);
    const text = r.permissionPrompt({ id: "1", tool: "run_command", summary: "rm -rf node_modules", reason: "recursively/forcibly deletes files", riskLevel: "dangerous", grantKey: "k", detail: "@@\n-a\n+b" });
    expect(text).toContain("rm -rf node_modules");
    expect(text).toContain("DANGEROUS");
    expect(text).toContain("+b");
    expect(text).not.toContain("always allow");
  });
  it("maps answers to decisions", () => {
    expect(parsePermissionAnswer("y", "confirm")).toBe("allow_once");
    expect(parsePermissionAnswer("s", "confirm")).toBe("allow_session");
    expect(parsePermissionAnswer("a", "confirm")).toBe("always_allow");
    expect(parsePermissionAnswer("a", "dangerous")).toBe("allow_session");
    expect(parsePermissionAnswer("N", "confirm")).toBe("always_deny");
    expect(parsePermissionAnswer("", "confirm")).toBe("deny");
    expect(parsePermissionAnswer("whatever", "dangerous")).toBe("deny");
  });
  it("colours diffs only when enabled", () => {
    expect(colorDiff("+a\n-b", makeStyle(false))).toBe("+a\n-b");
    expect(colorDiff("+a", makeStyle(true))).toContain("\u001b[32m");
  });
});

describe("runCli end to end (non-interactive)", () => {
  let modelServer: Server;
  let baseUrl: string;
  let turns: Array<{ text?: string; tool?: { name: string; args: unknown } }> = [];
  let calls = 0;
  let home: string;
  let proj: string;

  beforeAll(async () => {
    modelServer = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct" }] }));
        }
        const t = turns[calls++];
        if (!t) {
          res.writeHead(500);
          return res.end("no more turns");
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        if (t.text) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t.text } }] })}\n\n`);
        if (t.tool) res.write(`data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${calls}`, function: { name: t.tool.name, arguments: JSON.stringify(t.tool.args) } }] } }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: t.tool ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
        res.end();
      });
    });
    await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
    home = mkdtempSync(join(tmpdir(), "bc-cli-home-"));
    proj = mkdtempSync(join(tmpdir(), "bc-cli-proj-"));
    writeFileSync(join(proj, "notes.txt"), "hello\n");
  });
  afterAll(async () => {
    await new Promise<void>((r) => modelServer.close(() => r()));
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
    } catch {
      /* Windows may keep the SQLite file locked briefly; temp dir cleanup is best-effort */
    }
    rmSync(proj, { recursive: true, force: true });
  });

  const io = (): CliIO & { stdout: string; stderr: string } => {
    const o = {
      stdout: "",
      stderr: "",
      out(s: string) {
        o.stdout += s;
      },
      err(s: string) {
        o.stderr += s;
      },
      env: { BETA_CODE_BASE_URL: baseUrl } as NodeJS.ProcessEnv,
      cwd: proj,
      isTTY: false,
      color: false,
      home,
      dbFile: join(home, "db", "cli.db"),
    };
    return o;
  };

  it("runs a prompt with --yes: edits a file and exits 0", async () => {
    calls = 0;
    turns = [
      { text: "Reading.", tool: { name: "read_file", args: { path: "notes.txt" } } },
      { tool: { name: "edit_file", args: { path: "notes.txt", oldText: "hello", newText: "hello world" } } },
      { text: "Updated notes.txt." },
    ];
    const o = io();
    const code = await runCli(["-p", "append world", "--yes"], o);
    expect(code).toBe(0);
    expect(readFileSync(join(proj, "notes.txt"), "utf8")).toBe("hello world\n");
    expect(o.stdout).toContain("▸ read_file notes.txt");
    expect(o.stdout).toContain("M notes.txt +1 -1");
    expect(o.stdout).toContain("Updated notes.txt.");
    expect(o.stdout).toContain("● Completed");
  });

  it("without --yes, non-interactive edits are denied and exit code is 1", async () => {
    calls = 0;
    turns = [{ tool: { name: "write_file", args: { path: "new.txt", content: "x" } } }];
    const o = io();
    const code = await runCli(["-p", "make a file"], o);
    expect(code).toBe(1);
    expect(o.stdout).toContain("non-interactive: denied");
    expect(() => readFileSync(join(proj, "new.txt"))).toThrow();
  });

  it("--yes still refuses dangerous commands", async () => {
    calls = 0;
    turns = [{ tool: { name: "run_command", args: { command: "rm -rf ." } } }];
    const o = io();
    const code = await runCli(["-p", "clean", "--yes"], o);
    expect(code).toBe(1);
    expect(o.stdout).toContain("DANGEROUS");
    expect(readFileSync(join(proj, "notes.txt"), "utf8")).toContain("hello");
  });

  it("lists sessions, models and runs doctor", async () => {
    const s = io();
    expect(await runCli(["sessions"], s)).toBe(0);
    expect(s.stdout).toMatch(/append world/);
    const m = io();
    expect(await runCli(["models"], m)).toBe(0);
    expect(m.stdout).toContain("Qwen/Qwen3-Coder-30B-A3B-Instruct");
    const d = io();
    expect(await runCli(["doctor"], d)).toBe(0);
    expect(d.stdout).toContain("BetaCode Doctor");
    expect(d.stdout).toContain("✓ AI endpoint");
    expect(d.stdout).toContain("✓ Node.js");
    expect(d.stdout).toContain("✓ SQLite database");
  });

  it("shows and sets config without ever storing an API key", async () => {
    const o = io();
    o.env.BETA_CODE_API_KEY = "cli-secret-key-abcdefghijkl";
    expect(await runCli(["config"], o)).toBe(0);
    expect(o.stdout).toContain('"model": "Qwen/Qwen3-Coder-30B-A3B-Instruct"');
    expect(o.stdout).not.toContain("cli-secret-key");
    const set = io();
    expect(await runCli(["config", "set", "temperature", "0.2"], set)).toBe(0);
    expect(readFileSync(join(home, ".betacode", "config.json"), "utf8")).toContain('"temperature": 0.2');
    const bad = io();
    expect(await runCli(["config", "set", "apiKey", "x"], bad)).toBe(2);
    expect(await runCli(["config", "set", "temperature", "9"], io())).toBe(1);
  });

  it("prints usage errors", async () => {
    const o = io();
    expect(await runCli(["--mode", "nope"], o)).toBe(2);
    expect(o.stderr).toContain("--mode must be one of");
    expect(await runCli(["--help"], io())).toBe(0);
  });

  it("fails clearly when the project path does not exist", async () => {
    const o = io();
    expect(await runCli(["./does-not-exist", "-p", "x"], o)).toBe(1);
    expect(o.stderr).toContain("Not a directory");
  });
});
