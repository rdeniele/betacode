import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App, startHttpServer, type RunningServer } from "@betacode/server";
import type { ServerEvent } from "@betacode/server";

/**
 * End-to-end: the real HTTP API, real App/agent loop, real QwenProvider streaming over SSE from a local
 * OpenAI-compatible server, real tools operating on a real project, and a real `npm test` run.
 * Only the *model's decisions* are scripted — everything the agent does with them is real.
 */

type ModelTurn = { text?: string; tool?: { name: string; args: unknown } };

let modelServer: Server;
let modelUrl: string;
let requestsSeen: any[] = [];
let script: Array<(req: any) => ModelTurn>;

function sseChunk(res: import("node:http").ServerResponse, obj: unknown) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

beforeAll(async () => {
  modelServer = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.url === "/v1/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: "Qwen/Qwen3-Coder-30B-A3B-Instruct", max_model_len: 65536 }] }));
      }
      const body = JSON.parse(raw);
      requestsSeen.push(body);
      const turn = script[requestsSeen.length - 1]?.(body);
      if (!turn) {
        res.writeHead(500);
        return res.end("script exhausted");
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (turn.text) for (const part of turn.text.match(/.{1,12}/gs) ?? []) sseChunk(res, { choices: [{ delta: { content: part } }] });
      if (turn.tool) {
        const args = JSON.stringify(turn.tool.args);
        const mid = Math.floor(args.length / 2);
        sseChunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${requestsSeen.length}`, function: { name: turn.tool.name, arguments: args.slice(0, mid) } }] } }] });
        sseChunk(res, { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(mid) } }] } }] });
      }
      sseChunk(res, { choices: [{ delta: {}, finish_reason: turn.tool ? "tool_calls" : "stop" }] });
      sseChunk(res, { choices: [], usage: { prompt_tokens: 1000 + requestsSeen.length * 100, completion_tokens: 50 } });
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise<void>((r) => modelServer.listen(0, "127.0.0.1", r));
  modelUrl = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}/v1`;
});
afterAll(() => new Promise<void>((r) => modelServer.close(() => r())));

describe("MVP vertical slice: inspect → edit → run tests → fix → verify", () => {
  let home: string;
  let proj: string;
  let app: App;
  let http: RunningServer;
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${http.url}${path}`, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = await res.json();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${JSON.stringify(json)}`);
    return json as any;
  };

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "bc-e2e-home-"));
    proj = mkdtempSync(join(tmpdir(), "bc-e2e-proj-"));
    mkdirSync(join(proj, "src"));
    mkdirSync(join(proj, "test"));
    writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "demo-api", version: "1.0.0", scripts: { test: "node --test" } }, null, 2));
    writeFileSync(
      join(proj, "src/server.js"),
      `const http = require("node:http");\n\nfunction handler(req, res) {\n  if (req.url === "/") {\n    res.writeHead(200, { "Content-Type": "text/plain" });\n    return res.end("hello");\n  }\n  res.writeHead(404);\n  res.end("not found");\n}\n\nmodule.exports = { handler, create: () => http.createServer(handler) };\n`,
    );
    writeFileSync(
      join(proj, "test/health.test.js"),
      `const test = require("node:test");\nconst assert = require("node:assert");\nconst { create } = require("../src/server");\n\ntest("GET /health returns {status:'ok'}", async (t) => {\n  const s = create();\n  t.after(() => s.close());\n  await new Promise((r) => s.listen(0, r));\n  const res = await fetch("http://127.0.0.1:" + s.address().port + "/health");\n  assert.strictEqual(res.status, 200);\n  assert.deepStrictEqual(await res.json(), { status: "ok" });\n});\n`,
    );
    writeFileSync(join(proj, "BETACODE.md"), "# BetaCode Instructions\n\nUse CommonJS. Run npm test after changes.\n");

    app = await App.create({
      home,
      dbFile: join(home, "db", "betacode.db"),
      logFile: join(home, "logs", "betacode.log"),
      env: { BETA_CODE_BASE_URL: modelUrl, BETA_CODE_API_KEY: "e2e-secret-key-0123456789" } as NodeJS.ProcessEnv,
    });
    http = await startHttpServer(app);
  });

  afterAll(async () => {
    await http.close();
    await app.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  });

  it("completes the health-endpoint task, asking permission, showing diffs, and fixing a failing test", async () => {
    const buggyRoute = `  if (req.url === "/health") {\n    res.writeHead(200, { "Content-Type": "application/json" });\n    return res.end(JSON.stringify({ status: "okay" }));\n  }\n`;
    const fixedRoute = buggyRoute.replace("okay", "ok");
    const lastTool = (req: any) => req.messages.filter((m: any) => m.role === "tool").at(-1)?.content as string;

    requestsSeen = [];
    script = [
      () => ({ text: "I'll inspect the project first.", tool: { name: "list_directory", args: { path: ".", depth: 2 } } }),
      (req) => {
        expect(lastTool(req)).toContain("server.js");
        return { tool: { name: "read_file", args: { path: "src/server.js" } } };
      },
      (req) => {
        expect(lastTool(req)).toContain('1\tconst http = require("node:http");');
        return { text: "Adding a /health route.", tool: { name: "edit_file", args: { path: "src/server.js", oldText: '  res.writeHead(404);\n', newText: buggyRoute + '  res.writeHead(404);\n' } } };
      },
      (req) => {
        expect(lastTool(req)).toContain("Edited src/server.js");
        return { text: "Running the tests.", tool: { name: "run_command", args: { command: "npm test" } } };
      },
      (req) => {
        // The REAL failing test output must reach the model.
        const out = lastTool(req);
        expect(out).toMatch(/exit code: 1/);
        expect(out).toMatch(/okay|ok/);
        return { text: "The test expects status 'ok', not 'okay'. Fixing.", tool: { name: "edit_file", args: { path: "src/server.js", oldText: buggyRoute, newText: fixedRoute } } };
      },
      () => ({ tool: { name: "run_command", args: { command: "npm test" } } }),
      (req) => {
        expect(lastTool(req)).toMatch(/exit code: 0/);
        return { text: "Added GET /health returning {status:'ok'}. Changed: src/server.js. Ran `npm test`: it failed once (status was 'okay'), I fixed it, and the second run passed." };
      },
    ];

    // 1. open project (detection)
    const opened = await api("POST", "/api/project/open", { path: proj });
    expect(opened.info.languages).toContain("JavaScript");
    expect(opened.info.commands.find((c: any) => c.name === "test").command).toMatch(/npm test/);
    expect(opened.instructionFiles).toEqual(["BETACODE.md"]);

    // 2. subscribe to the live event stream like the UI does
    const events: ServerEvent[] = [];
    const permissionsSeen: any[] = [];
    const unsub = app.bus.subscribe((e) => {
      events.push(e);
      if (e.scope === "session" && e.event.type === "permission.requested") {
        permissionsSeen.push(e.event.request);
        void api("POST", `/api/permissions/${e.event.request.id}`, { decision: "allow_once" });
      }
    });

    // 3. create session and send the task
    const session = await api("POST", "/api/sessions", {});
    const started = await api("POST", `/api/sessions/${session.id}/messages`, { text: "Inspect this project and create a simple /health endpoint. Run the appropriate tests and fix any issues." });
    expect(started).toMatchObject({ kind: "run", started: true });
    await app.waitForIdle(session.id);
    unsub();

    // 4. the agent actually did the work
    const final = readFileSync(join(proj, "src/server.js"), "utf8");
    expect(final).toContain('JSON.stringify({ status: "ok" })');
    expect(final).not.toContain("okay");

    const detail = await api("GET", `/api/sessions/${session.id}`);
    expect(detail.running).toBe(false);
    const completed = events.filter((e) => e.scope === "session" && e.event.type === "agent.completed");
    expect(completed.map((e: any) => e.event.reason)).toEqual(["completed"]);

    // 5. permission requests were real and described the action; reads and `npm test` needed none
    expect(permissionsSeen.map((p) => p.tool)).toEqual(["edit_file", "edit_file"]);
    expect(permissionsSeen[0].detail).toContain("+  if (req.url === \"/health\")");
    expect(permissionsSeen.every((p) => p.riskLevel === "confirm")).toBe(true);

    // 6. the model saw BETACODE.md and the project summary
    const sys = requestsSeen[0].messages[0].content as string;
    expect(sys).toContain("Use CommonJS");
    expect(sys).toContain("Package manager: npm");
    expect(requestsSeen[0].tools.map((t: any) => t.function.name)).toContain("edit_file");
    expect(requestsSeen[0]).toMatchObject({ model: "Qwen/Qwen3-Coder-30B-A3B-Instruct", top_k: 20, repetition_penalty: 1.05, temperature: 0.7, top_p: 0.8, stream: true });

    // 7. diffs/changes are tracked as one coalesced change with the original content preserved
    expect(detail.changes).toHaveLength(1);
    expect(detail.changes[0]).toMatchObject({ path: "src/server.js", kind: "modified", status: "pending" });
    expect(detail.changes[0].diff).toContain('+    return res.end(JSON.stringify({ status: "ok" }));');
    expect(detail.changes[0].diff).not.toContain("okay");

    // 8. tool calls, in order, with real outcomes — including the failing test run
    expect(detail.toolCalls.map((t: any) => [t.name, t.ok])).toEqual([
      ["list_directory", true],
      ["read_file", true],
      ["edit_file", true],
      ["run_command", false],
      ["edit_file", true],
      ["run_command", true],
    ]);
    expect(detail.toolCalls[3].result).toContain("exit code: 1");

    // 9. the transcript was persisted and the title derived from the request
    const roles = detail.messages.map((m: any) => m.role);
    expect(roles[0]).toBe("user");
    expect(roles.at(-1)).toBe("assistant");
    expect(detail.messages.at(-1).content).toContain("second run passed");
    expect(detail.session.title).toMatch(/^Inspect this project/);
    expect(detail.usage.inputTokens).toBeGreaterThan(0);

    // 10. live streaming: text arrived as multiple deltas before completion
    const deltas = events.filter((e) => e.scope === "session" && e.event.type === "agent.text");
    expect(deltas.length).toBeGreaterThan(3);
    // states the UI shows
    const states = new Set(events.filter((e) => e.scope === "session" && e.event.type === "agent.state").map((e: any) => e.event.state));
    for (const s of ["THINKING", "READING", "EDITING", "TESTING", "WAITING_FOR_PERMISSION", "RECOVERING", "COMPLETED"]) expect(states.has(s)).toBe(true);

    // 11. no secrets in the logs
    const log = readFileSync(join(home, "logs", "betacode.log"), "utf8");
    expect(log).toContain("tool.completed");
    expect(log).not.toContain("e2e-secret-key-0123456789");

    // 12. revert restores the original file from the snapshot
    await api("POST", `/api/sessions/${session.id}/changes/${detail.changes[0].id}/revert`, {});
    expect(readFileSync(join(proj, "src/server.js"), "utf8")).not.toContain("/health");
  }, 60_000);

  it("resumes a persisted session in a fresh App instance", async () => {
    const sessions = await api("GET", "/api/sessions");
    expect(sessions).toHaveLength(1);
    const app2 = await App.create({ home, dbFile: join(home, "db", "betacode.db"), logFile: false, env: { BETA_CODE_BASE_URL: modelUrl } as NodeJS.ProcessEnv });
    await app2.openProject(proj);
    const detail = await app2.getSession(sessions[0].id);
    expect(detail.messages.length).toBeGreaterThan(10);
    expect(detail.toolCalls).toHaveLength(6);
    expect(detail.changes).toHaveLength(1);
    expect(detail.changes[0]!.status).toBe("reverted");

    // The resumed agent continues with the full prior context.
    requestsSeen = [];
    script = [(req) => ({ text: `I remember: ${req.messages.length} messages.` })];
    await app2.sendMessage(sessions[0].id, "What did you do before?");
    await app2.waitForIdle(sessions[0].id);
    expect(requestsSeen[0].messages.some((m: any) => m.role === "tool" && m.content.includes("exit code: 1"))).toBe(true);
    await app2.close();
  }, 30_000);

  it("rejects requests from foreign origins and hosts", async () => {
    const bad = await fetch(`${http.url}/api/state`, { headers: { Origin: "https://evil.example" } });
    expect(bad.status).toBe(403);
    const ok = await fetch(`${http.url}/api/health`, { headers: { Origin: "http://localhost:1420" } });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:1420");
  });
});
