import { createInterface, type Interface } from "node:readline";
import { resolve } from "node:path";
import { App, formatDoctor, runDoctor, HELP_TEXT } from "@betacode/server";
import { saveConfig, loadConfig, ConfigSchema } from "@betacode/config";
import { INIT_PROMPT } from "@betacode/prompts";
import { BetaCodeError, type AgentMode } from "@betacode/shared";
import { UsageError, USAGE, parseArgs, type CliArgs } from "./args";
import { Renderer, makeStyle, parsePermissionAnswer } from "./render";

export interface CliIO {
  out: (s: string) => void;
  err: (s: string) => void;
  env: NodeJS.ProcessEnv;
  cwd: string;
  isTTY: boolean;
  input?: NodeJS.ReadableStream;
  color?: boolean;
  /** Override for tests so no files land in the real home directory. */
  home?: string;
  dbFile?: string;
}

const VERSION = "0.1.0";

function envFromArgs(args: CliArgs, env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const e = { ...env };
  if (args.model) e.BETA_CODE_MODEL = args.model;
  if (args.provider) e.BETA_CODE_PROVIDER = args.provider;
  if (args.baseUrl) e.BETA_CODE_BASE_URL = args.baseUrl;
  return e;
}

/** Entry point. Returns the process exit code. */
export async function runCli(argv: string[], io: CliIO): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${e.message}\n\n${USAGE}\n`);
      return 2;
    }
    throw e;
  }
  if (args.command === "help") return (io.out(USAGE + "\n"), 0);
  if (args.command === "version") return (io.out(`betacode ${VERSION}\n`), 0);

  const env = envFromArgs(args, io.env);

  if (args.command === "config") return configCommand(args, io, env);

  const app = await App.create({ home: io.home, dbFile: io.dbFile, env, autoApprove: args.yes ? "confirm" : "none" });
  try {
    const root = resolve(io.cwd, args.path ?? ".");
    try {
      await app.openProject(root);
    } catch (e) {
      io.err(`${(e as Error).message}\n`);
      return 1;
    }

    switch (args.command) {
      case "doctor":
        io.out(formatDoctor(await runDoctor(app)) + "\n");
        return 0;
      case "models": {
        const t = await app.testConnection();
        if (!t.ok) return (io.err(`Cannot reach ${app.config().baseUrl}: ${t.error}\n`), 1);
        io.out(t.models.map((m) => `${m === app.config().model ? "* " : "  "}${m}`).join("\n") + "\n");
        return 0;
      }
      case "sessions": {
        const list = await app.listSessions();
        io.out(list.length ? list.map((s) => `${s.id}  ${s.updatedAt.toISOString().slice(0, 16).replace("T", " ")}  ${s.title}`).join("\n") + "\n" : "No sessions yet.\n");
        return 0;
      }
      default:
        return chat(app, args, io);
    }
  } finally {
    await app.close();
  }
}

function configCommand(args: CliArgs, io: CliIO, env: NodeJS.ProcessEnv): number {
  void env;
  const [sub, key, ...value] = args.rest;
  if (sub === "set") {
    if (!key || !value.length) return (io.err("usage: betacode config set <key> <value>\n"), 2);
    const shape = ConfigSchema.shape as Record<string, unknown>;
    if (!(key in shape) || key === "apiKey") return (io.err(`Unknown or non-persistable key "${key}". API keys are read from BETA_CODE_API_KEY and never stored.\n`), 2);
    const raw = value.join(" ");
    let parsed: unknown = raw;
    try {
      parsed = JSON.parse(raw);
    } catch {
      /* plain string */
    }
    try {
      const file = saveConfig({ [key]: parsed } as never, { scope: "global", home: io.home });
      io.out(`Saved ${key} to ${file}\n`);
      return 0;
    } catch (e) {
      io.err(`${(e as Error).message}\n`);
      return 1;
    }
  }
  // Show effective config (key masked).
  return (showConfig(io, env), 0);
}

function showConfig(io: CliIO, env: NodeJS.ProcessEnv): void {
  const { apiKey, ...cfg } = loadConfig({ home: io.home, env, projectRoot: io.cwd });
  io.out(JSON.stringify({ ...cfg, apiKey: apiKey ? "(set via environment)" : undefined }, null, 2) + "\n");
}

async function chat(app: App, args: CliArgs, io: CliIO): Promise<number> {
  const style = makeStyle(io.color ?? io.isTTY);
  const renderer = new Renderer((s) => io.out(s), style, { verboseTools: false });
  const cfg = app.config();
  const mode: AgentMode = args.mode ?? "code";

  // Find or create the session.
  let sessionId: string;
  const existing = args.continue ? (await app.listSessions())[0] : undefined;
  if (existing) sessionId = existing.id;
  else sessionId = (await app.createSession({ mode })).id;

  const project = app.project!;
  io.out(`${style.bold("BetaCode")} ${style.dim(`· ${project.info.name} · ${cfg.model} · ${cfg.baseUrl}`)}\n`);
  const t = await app.testConnection();
  io.out(t.ok ? style.dim(t.modelAvailable ? "model endpoint reachable\n" : `endpoint reachable, but model "${cfg.model}" not listed\n`) : style.yellow(`⚠ cannot reach ${cfg.baseUrl}: ${t.error}\n  Run \`betacode doctor\` or see docs/local-model.md.\n`));
  if (existing) io.out(style.dim(`resuming session "${existing.title}"\n`));

  let rl: Interface | undefined;
  let currentMode = mode;
  let runExitCode = 0;

  // Permission prompts
  const promptQueue: Array<() => Promise<void>> = [];
  let prompting = false;
  const drain = async () => {
    if (prompting) return;
    prompting = true;
    while (promptQueue.length) await promptQueue.shift()!();
    prompting = false;
  };
  const unsub = app.bus.subscribe((e) => {
    if (e.scope !== "session" || e.sessionId !== sessionId) return;
    renderer.handle(e.event);
    if (e.event.type === "agent.completed") runExitCode = e.event.reason === "completed" ? 0 : 1;
    if (e.event.type === "permission.requested") {
      const req = e.event.request;
      promptQueue.push(async () => {
        renderer.line(renderer.permissionPrompt(req));
        if (!rl) {
          renderer.line(style.dim("(non-interactive: denied — re-run with --yes to auto-approve edits and ordinary commands)"));
          app.resolvePermission(req.id, "deny");
          return;
        }
        const answer = await new Promise<string>((res) => rl!.question(style.bold("> "), res));
        app.resolvePermission(req.id, parsePermissionAnswer(answer, req.riskLevel));
      });
      void drain();
    }
  });

  try {
    if (args.prompt !== undefined || args.command === "init") {
      const text = args.command === "init" ? INIT_PROMPT : args.prompt!;
      if (io.isTTY || io.input) rl = createInterface({ input: (io.input ?? process.stdin) as NodeJS.ReadableStream, output: undefined, terminal: false });
      await app.sendMessage(sessionId, text, { mode: args.command === "init" ? "code" : currentMode });
      await app.waitForIdle(sessionId);
      rl?.close();
      renderer.line("");
      return runExitCode;
    }

    rl = createInterface({ input: (io.input ?? process.stdin) as NodeJS.ReadableStream, output: process.stdout, terminal: io.isTTY, prompt: style.bold("› ") });
    io.out(style.dim("Type a request, or /help. Esc/Ctrl+C stops the agent; Ctrl+D exits.\n"));
    rl.prompt();

    let busy = false;
    const sigint = () => {
      if (busy && app.cancel(sessionId)) io.out(style.yellow("\nstopping…\n"));
      else {
        io.out("\n");
        rl!.close();
      }
    };
    rl.on("SIGINT", sigint);

    await new Promise<void>((done) => {
      rl!.on("close", done);
      rl!.on("line", async (line) => {
        if (prompting) return; // answers are handled by rl.question
        const text = line.trim();
        if (!text) return rl!.prompt();
        if (busy) return;
        busy = true;
        try {
          if (text === "/exit" || text === "/quit") return rl!.close();
          if (text.startsWith("/mode")) {
            const m = text.split(/\s+/)[1] as AgentMode;
            if (["ask", "code", "plan", "review", "debug", "explore"].includes(m)) {
              currentMode = m;
              io.out(style.dim(`mode: ${m}\n`));
            } else io.out(`usage: /mode ask|code|plan|review|debug|explore (current: ${currentMode})\n`);
          } else if (text.startsWith("/")) {
            const r = await app.slash(sessionId, text, currentMode);
            if (r.kind === "text") io.out(r.text + "\n");
            else if (r.kind === "ui") io.out(style.dim(r.action === "settings" ? "Use `betacode config` / environment variables to change the model.\n" : "Use `betacode sessions` to list sessions.\n"));
            else await app.waitForIdle(sessionId);
          } else {
            await app.sendMessage(sessionId, text, { mode: currentMode });
            await app.waitForIdle(sessionId);
          }
        } catch (e) {
          io.err(`${e instanceof BetaCodeError ? e.message : (e as Error).message}\n`);
        } finally {
          busy = false;
          if (!prompting) rl!.prompt();
        }
      });
    });
    return 0;
  } finally {
    unsub();
    rl?.close();
  }
}

export { HELP_TEXT };
