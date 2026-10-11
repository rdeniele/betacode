import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { BetaCodeError, z } from "@betacode/shared";
import type { App } from "./app";
import { runDoctor } from "./doctor";
import type { ServerEvent } from "./events";

export interface HttpOptions {
  port?: number;
  host?: string;
  /** Extra allowed browser origins (the dev server and Tauri webview are always allowed). */
  allowedOrigins?: string[];
}

const DEFAULT_ORIGINS = ["http://localhost:1420", "http://127.0.0.1:1420", "tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const MAX_BODY = 10 * 1024 * 1024;

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly code = "ERROR") {
    super(message);
  }
}

type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: any }) => Promise<unknown> | unknown;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:([a-zA-Z]+)/g, (_m, k) => (keys.push(k), "([^/]+)")) + "$");
  return { method, re, keys, handler };
}

const mode = z.enum(["ask", "code", "plan", "review", "debug", "explore"]);
const decision = z.enum(["allow_once", "allow_session", "always_allow", "always_deny", "deny"]);

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "), "BAD_REQUEST");
  return r.data;
}

export function buildRoutes(app: App): Route[] {
  return [
    route("GET", "/api/health", () => ({ ok: true, name: "BetaCode", version: "0.1.0" })),
    route("GET", "/api/state", async () => ({ project: app.project ? await app.projectSummary() : null, config: app.publicConfig() })),
    route("GET", "/api/projects", () => app.listRecentProjects()),
    route("POST", "/api/project/open", async ({ body }) => app.openProject(parse(z.object({ path: z.string().min(1) }), body).path)),
    route("GET", "/api/project", () => app.projectSummary()),
    route("GET", "/api/tree", ({ query }) => app.tree(query.get("path") ?? ".", Number(query.get("depth") ?? 1))),
    route("GET", "/api/file", ({ query }) => app.readFile(query.get("path") ?? "")),
    route("PUT", "/api/file", ({ body }) => {
      const b = parse(z.object({ path: z.string().min(1), content: z.string() }), body);
      return app.saveFile(b.path, b.content);
    }),
    route("GET", "/api/search", ({ query }) => app.search(query.get("q") ?? "", { regex: query.get("regex") === "1", glob: query.get("glob") ?? undefined })),
    route("GET", "/api/quick-open", ({ query }) => ({ files: app.quickOpen(query.get("q") ?? "") })),

    route("GET", "/api/git/status", async () => ({ status: await app.gitStatus() })),
    route("GET", "/api/git/diff", async ({ query }) => ({ diff: await app.git().diff({ staged: query.get("staged") === "1", path: query.get("path") ?? undefined }) })),
    route("GET", "/api/git/log", async () => ({ commits: await app.git().log(30) })),
    route("GET", "/api/git/branches", async () => ({ branches: await app.git().branches() })),
    route("POST", "/api/git/add", async ({ body }) => (await app.git().add(parse(z.object({ paths: z.array(z.string()).min(1) }), body).paths), { ok: true })),
    route("POST", "/api/git/commit", async ({ body }) => app.git().commit(parse(z.object({ message: z.string().min(1) }), body).message)),
    route("POST", "/api/git/checkout", async ({ body }) => {
      const b = parse(z.object({ branch: z.string().min(1), create: z.boolean().optional() }), body);
      return { output: await app.git().checkout(b.branch, { create: b.create }) };
    }),
    route("POST", "/api/git/push", async () => ({ output: await app.git().push() })),
    route("POST", "/api/git/pull", async () => ({ output: await app.git().pull() })),

    route("GET", "/api/sessions", ({ query }) => app.listSessions(query.get("q") ?? undefined)),
    route("POST", "/api/sessions", ({ body }) => app.createSession(parse(z.object({ title: z.string().optional(), mode: mode.optional() }), body))),
    route("GET", "/api/sessions/:id", ({ params }) => app.getSession(params.id!)),
    route("PATCH", "/api/sessions/:id", async ({ params, body }) => {
      const b = parse(z.object({ title: z.string().min(1) }), body);
      await app.renameSession(params.id!, b.title);
      return { ok: true };
    }),
    route("DELETE", "/api/sessions/:id", async ({ params }) => (await app.deleteSession(params.id!), { ok: true })),
    route("POST", "/api/sessions/:id/duplicate", ({ params }) => app.duplicateSession(params.id!)),
    route("POST", "/api/sessions/:id/messages", async ({ params, body }) => {
      const b = parse(z.object({ text: z.string().min(1), mode: mode.optional() }), body);
      if (b.text.trim().startsWith("/")) return app.slash(params.id!, b.text, b.mode);
      await app.sendMessage(params.id!, b.text, { mode: b.mode });
      return { kind: "run", started: true };
    }),
    route("POST", "/api/sessions/:id/cancel", ({ params }) => ({ cancelled: app.cancel(params.id!) })),
    route("GET", "/api/sessions/:id/changes", ({ params }) => app.changes(params.id!)),
    route("POST", "/api/sessions/:id/changes/accept-all", async ({ params }) => (await app.acceptAll(params.id!), { ok: true })),
    route("POST", "/api/sessions/:id/changes/:changeId/accept", ({ params }) => app.acceptChange(params.id!, params.changeId!)),
    route("POST", "/api/sessions/:id/changes/:changeId/revert", ({ params, body }) => app.revertChange(params.id!, params.changeId!, !!body?.force)),
    route("POST", "/api/sessions/:id/undo", async ({ params }) => ({ change: await app.undo(params.id!) ?? null })),
    route("POST", "/api/sessions/:id/redo", async ({ params }) => ({ change: await app.redo(params.id!) ?? null })),

    route("POST", "/api/permissions/:id", ({ params, body }) => ({ resolved: app.resolvePermission(params.id!, parse(z.object({ decision }), body).decision) })),
    route("GET", "/api/permission-rules", () => app.listPermissionRules()),
    route("DELETE", "/api/permission-rules/:tool", async ({ params }) => (await app.deletePermissionRule(decodeURIComponent(params.tool!)), { ok: true })),

    route("GET", "/api/config", () => app.publicConfig()),
    route("PUT", "/api/config", ({ body }) => {
      const b = parse(
        z.object({
          provider: z.string().min(1).optional(),
          model: z.string().min(1).optional(),
          baseUrl: z.string().url().optional(),
          apiKey: z.string().optional(),
          teacher: z.object({ enabled: z.boolean().optional(), provider: z.string().min(1).optional(), baseUrl: z.string().url(), model: z.string().min(1) }).optional(),
          teacherKey: z.string().optional(),
          rememberTeacherKey: z.boolean().optional(),
          forgetTeacherKey: z.boolean().optional(),
          rememberKey: z.boolean().optional(),
          forgetKey: z.boolean().optional(),
          temperature: z.number().optional(),
          topP: z.number().optional(),
          topK: z.number().optional(),
          repetitionPenalty: z.number().optional(),
          contextLength: z.number().optional(),
          maxIterations: z.number().optional(),
          maxRetries: z.number().optional(),
          autoCompact: z.boolean().optional(),
          permissions: z.record(z.string(), z.enum(["safe", "confirm", "dangerous", "deny"])).optional(),
        }),
        body,
      );
      app.updateConfig(b);
      return app.publicConfig();
    }),
    route("POST", "/api/config/test", () => app.testConnection()),
    route("POST", "/api/config/test-teacher", ({ body }) =>
      app.testTeacher(parse(z.object({ baseUrl: z.string().url().optional(), provider: z.string().optional(), model: z.string().optional(), apiKey: z.string().optional() }), body)),
    ),
    route("GET", "/api/setup/overview", () => app.setupOverview()),
    route("POST", "/api/setup/apply-env", ({ body }) =>
      app.setupApplyEnv(parse(z.object({ contextLength: z.number().int().min(2048).max(262144), modelsDir: z.string().min(2).optional(), restart: z.boolean().optional() }), body)),
    ),
    route("POST", "/api/setup/pull", ({ body }) => (app.setupPull(parse(z.object({ tag: z.string().min(1).max(100) }), body).tag), { started: true })),
    route("POST", "/api/setup/pull/cancel", () => ({ cancelled: app.setupCancelPull() })),
    route("POST", "/api/setup/use", ({ body }) => {
      const b = parse(z.object({ tag: z.string().min(1), contextLength: z.number().int().min(2048) }), body);
      app.setupUseModel(b.tag, b.contextLength);
      return app.publicConfig();
    }),
    route("GET", "/api/doctor", async () => ({ checks: await runDoctor(app) })),

    route("POST", "/api/terminal/:id/run", async ({ params, body }) => (await app.runTerminal(params.id!, parse(z.object({ command: z.string().min(1) }), body).command), { ok: true })),
    route("POST", "/api/terminal/:id/cancel", ({ params }) => ({ cancelled: app.cancelTerminal(params.id!) })),
  ];
}

function errorStatus(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof BetaCodeError) {
    const status = e.code === "NOT_FOUND" ? 404 : e.code === "BUSY" || e.code === "CONFLICT" ? 409 : e.code === "NO_PROJECT" ? 412 : e.code === "OUTSIDE_WORKSPACE" || e.code === "SENSITIVE" ? 403 : 400;
    return { status, code: e.code, message: e.message };
  }
  return { status: 500, code: "INTERNAL", message: (e as Error).message ?? "Internal error" };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, "Request body too large", "TOO_LARGE");
    chunks.push(c as Buffer);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON", "BAD_REQUEST");
  }
}

export interface RunningServer {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/**
 * Local HTTP + SSE API for the desktop/web UI. Binds to loopback only, rejects non-local Host headers
 * (DNS rebinding) and cross-origin requests from origins other than the app's own.
 */
export async function startHttpServer(app: App, opts: HttpOptions = {}): Promise<RunningServer> {
  const routes = buildRoutes(app);
  const allowed = new Set([...DEFAULT_ORIGINS, ...(opts.allowedOrigins ?? [])]);
  const sse = new Set<ServerResponse>();

  const unsubscribe = app.bus.subscribe((e: ServerEvent) => {
    const data = `data: ${JSON.stringify(e)}\n\n`;
    for (const res of sse) res.write(data);
  });
  const heartbeat = setInterval(() => {
    for (const res of sse) res.write(": ping\n\n");
  }, 15_000);
  heartbeat.unref();

  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json", ...(origin && allowed.has(origin) ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}) });
      res.end(JSON.stringify(payload));
    };
    try {
      if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) throw new HttpError(403, "Forbidden host", "FORBIDDEN");
      if (origin && !allowed.has(origin)) throw new HttpError(403, "Forbidden origin", "FORBIDDEN");

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": origin ?? "",
          "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
          Vary: "Origin",
        });
        return res.end();
      }

      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/api/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
        });
        res.write(": connected\n\n");
        sse.add(res);
        req.on("close", () => sse.delete(res));
        return;
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]));
        const body = req.method === "GET" || req.method === "DELETE" ? undefined : await readBody(req);
        const result = await r.handler({ params, query: url.searchParams, body });
        return send(200, result ?? { ok: true });
      }
      throw new HttpError(404, `No route for ${req.method} ${url.pathname}`, "NOT_FOUND");
    } catch (e) {
      const { status, code, message } = errorStatus(e);
      if (status >= 500) app.logger.log("error", "http.error", { message, path: req.url });
      if (!res.headersSent) send(status, { error: { code, message } });
      else res.end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        unsubscribe();
        for (const res of sse) res.end();
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
