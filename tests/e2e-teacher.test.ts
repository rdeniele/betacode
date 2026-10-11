import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { App } from "@betacode/server";

/**
 * Two real HTTP model servers: a "local" model that keeps making the same failing call, and a "helper" model that
 * solves the task. Everything between them (consent prompt, hand-over, tools, files) is the real code path.
 */

type Turn = { text?: string; tool?: { name: string; args: unknown } };

function modelServer(script: Turn[], seen: any[]): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        if (req.url?.endsWith("/models")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          return res.end(JSON.stringify({ data: [{ id: "m" }] }));
        }
        const body = JSON.parse(raw);
        seen.push(body);
        const turn = script[Math.min(seen.length - 1, script.length - 1)]!;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        if (turn.text) send({ choices: [{ delta: { content: turn.text } }] });
        if (turn.tool) send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c${seen.length}`, function: { name: turn.tool.name, arguments: JSON.stringify(turn.tool.args) } }] } }] });
        send({ choices: [{ delta: {}, finish_reason: turn.tool ? "tool_calls" : "stop" }] });
        send({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 20 } });
        res.write("data: [DONE]\n\n");
        res.end();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }));
  });
}

describe("teacher escalation end to end", () => {
  const studentSeen: any[] = [];
  const teacherSeen: any[] = [];
  let student: { server: Server; url: string };
  let teacher: { server: Server; url: string };
  let home: string;
  let proj: string;
  let app: App;

  beforeAll(async () => {
    // The local model repeats one failing call forever.
    student = await modelServer([{ tool: { name: "read_file", args: { path: "does-not-exist.txt" } } }], studentSeen);
    // The helper reads the real file, fixes it, and reports.
    teacher = await modelServer(
      [
        { tool: { name: "read_file", args: { path: "greeting.txt" } } },
        { tool: { name: "edit_file", args: { path: "greeting.txt", oldText: "helo", newText: "hello" } } },
        { text: "Fixed the typo in greeting.txt (helo → hello)." },
      ],
      teacherSeen,
    );
    home = mkdtempSync(join(tmpdir(), "bc-t-home-"));
    proj = mkdtempSync(join(tmpdir(), "bc-t-proj-"));
    writeFileSync(join(proj, "greeting.txt"), "helo world\n");
    app = await App.create({ home, dbFile: join(home, "db", "t.db"), logFile: false, env: { BETA_CODE_BASE_URL: student.url, BETA_CODE_MODEL: "local-small" } as NodeJS.ProcessEnv });
    await app.openProject(proj);
    app.updateConfig({ maxIterations: 25, teacher: { baseUrl: teacher.url, model: "helper-big", provider: "openai-compatible" } });
  });

  afterAll(async () => {
    await app.close();
    student.server.closeAllConnections?.();
    teacher.server.closeAllConnections?.();
    await Promise.all([new Promise((r) => student.server.close(r)), new Promise((r) => teacher.server.close(r))]);
    try {
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      /* Windows may keep the SQLite file briefly */
    }
    rmSync(proj, { recursive: true, force: true });
  });

  it("asks before sending anything, then the helper completes the task with the real tools", async () => {
    const consents: any[] = [];
    app.bus.subscribe((e) => {
      if (e.scope === "session" && e.event.type === "permission.requested") {
        if (e.event.request.tool === "escalate_to_teacher") consents.push(e.event.request);
        app.resolvePermission(e.event.request.id, "allow_once");
      }
    });
    expect(app.publicConfig().teacherReady).toBe(true);

    const s = await app.createSession();
    const teacherBefore = teacherSeen.length;
    await app.sendMessage(s.id, "Fix the typo in greeting.txt");
    await app.waitForIdle(s.id);

    // The consent request named the helper and where the data goes.
    expect(consents).toHaveLength(1);
    expect(consents[0].summary).toContain("helper-big");
    expect(consents[0].detail).toMatch(/will be sent to 127\.0\.0\.1:\d+/);
    // Nothing reached the helper before the consent.
    expect(studentSeen.length).toBeGreaterThanOrEqual(4);
    expect(teacherBefore).toBe(0);
    // The helper then saw the history, used the model name it was configured with, and fixed the file.
    expect(teacherSeen.length).toBe(3);
    expect(teacherSeen[0].model).toBe("helper-big");
    expect(teacherSeen[0].messages.some((m: any) => m.role === "tool" && String(m.content).includes("File not found"))).toBe(true);
    expect(readFileSync(join(proj, "greeting.txt"), "utf8")).toBe("hello world\n");

    const detail = await app.getSession(s.id);
    expect(detail.messages.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining("Fixed the typo") });
    expect(detail.messages.some((m) => m.role === "user" && m.content.includes("is taking over"))).toBe(true);
  }, 60_000);
});
