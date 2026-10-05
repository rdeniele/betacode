import { existsSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AgentSession, SUMMARY_MARKER, type RuleStore, type PermissionRule } from "@betacode/agent";
import { createProvider, type AIProvider, type ProviderConfig } from "@betacode/ai";
import { loadConfig, saveConfig, type BetaCodeConfig, type ConfigInput } from "@betacode/config";
import { Database, type ProjectRecord, type SessionRecord } from "@betacode/database";
import { ChangeTracker, FileService, Workspace, findFiles, searchText, renderTree, type DirEntry, type SearchMatch, type TrackedChange } from "@betacode/filesystem";
import { Git, formatStatus, type GitStatus } from "@betacode/git";
import { INIT_PROMPT } from "@betacode/prompts";
import { detectProject, findInstructions, formatProject, type ProjectInfo } from "@betacode/project";
import {
  BetaCodeError,
  FileLogger,
  nullLogger,
  type AgentEvent,
  type AgentMode,
  type ChatMessage,
  type FileChangeInfo,
  type Logger,
  type PermissionDecision,
  type PlanItem,
  type TokenUsage,
} from "@betacode/shared";
import { runCommand } from "@betacode/terminal";
import { PermissionBroker } from "./broker";
import { EventBus } from "./events";

export interface AppOptions {
  home?: string;
  dbFile?: string;
  env?: NodeJS.ProcessEnv;
  providerFactory?: (cfg: ProviderConfig) => AIProvider;
  logFile?: string | false;
  /** Non-interactive approval policy (CLI --yes). */
  autoApprove?: "none" | "confirm";
}

class CachedRuleStore implements RuleStore {
  private readonly map = new Map<string, PermissionRule>();
  constructor(initial: PermissionRule[], private readonly persist: (tool: string, decision: "allow" | "deny") => void) {
    for (const r of initial) this.map.set(r.tool, r);
  }
  list(): PermissionRule[] {
    return [...this.map.values()];
  }
  set(tool: string, decision: "allow" | "deny"): void {
    this.map.set(tool, { tool, decision });
    this.persist(tool, decision);
  }
}

interface LiveSession {
  id: string;
  session: AgentSession;
  running: boolean;
  ctrl?: AbortController;
  done?: Promise<void>;
  queue: Promise<void>;
  toolRows: Map<string, Promise<string>>;
  titled: boolean;
  rules: CachedRuleStore;
}

export interface OpenProjectResult {
  record: ProjectRecord;
  info: ProjectInfo;
  summary: string;
  instructionFiles: string[];
  git: { isRepo: boolean; branch: string | null };
}

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  models: string[];
  modelAvailable: boolean;
  contextLength?: number;
  error?: string;
}

export interface SessionDetail {
  session: SessionRecord;
  messages: ChatMessage[];
  toolCalls: Array<{ callId: string; name: string; args: string; ok: boolean | null; durationMs: number | null; result: string | null }>;
  changes: FileChangeInfo[];
  running: boolean;
  plan: PlanItem[];
  pendingPermissions: ReturnType<PermissionBroker["list"]>;
  usage: TokenUsage;
}

export type SlashResult = { kind: "text"; text: string } | { kind: "run"; started: boolean } | { kind: "ui"; action: string };

const MAX_FILE_VIEW_BYTES = 2 * 1024 * 1024;

/** Application service: owns the database, the open project and live agent sessions. UI-agnostic. */
export class App {
  readonly bus = new EventBus();
  readonly broker = new PermissionBroker();
  readonly home: string;
  readonly logger: Logger;
  project?: { record: ProjectRecord; root: string; info: ProjectInfo; fs: FileService };
  private readonly live_ = new Map<string, LiveSession>();
  private readonly terminals = new Map<string, AbortController>();
  private apiKeyOverride?: string;
  private detectedContext?: number;
  private readonly env: NodeJS.ProcessEnv;

  private constructor(
    readonly db: Database,
    private readonly opts: AppOptions,
  ) {
    this.home = opts.home ?? homedir();
    this.env = opts.env ?? process.env;
    this.logger = opts.logFile === false ? nullLogger : new FileLogger(opts.logFile ?? join(this.home, ".betacode", "logs", "betacode.log"));
  }

  static async create(opts: AppOptions = {}): Promise<App> {
    const home = opts.home ?? homedir();
    const db = await Database.open(opts.dbFile ?? join(home, ".betacode", "betacode.db"));
    return new App(db, opts);
  }

  async close(): Promise<void> {
    for (const l of this.live_.values()) l.ctrl?.abort();
    for (const t of this.terminals.values()) t.abort();
    await Promise.allSettled([...this.live_.values()].map((l) => l.done));
    await Promise.allSettled([...this.live_.values()].map((l) => l.queue));
    await this.db.close();
  }

  // ---------------------------------------------------------------- config

  config(): BetaCodeConfig {
    const cfg = loadConfig({ projectRoot: this.project?.root, home: this.home, env: this.env });
    if (this.apiKeyOverride !== undefined) cfg.apiKey = this.apiKeyOverride || undefined;
    if (this.detectedContext && this.detectedContext < cfg.contextLength) cfg.contextLength = this.detectedContext;
    return cfg;
  }

  /** Config safe to send to a UI: never includes the API key itself. */
  publicConfig(): Omit<BetaCodeConfig, "apiKey"> & { hasApiKey: boolean; detectedContextLength?: number } {
    const { apiKey, ...rest } = this.config();
    return { ...rest, hasApiKey: !!apiKey, detectedContextLength: this.detectedContext };
  }

  updateConfig(patch: Partial<ConfigInput>, scope: "global" | "project" = "global"): void {
    const { apiKey, ...rest } = patch;
    // The key lives in memory for this run (or in BETA_CODE_API_KEY); it is never written to disk.
    if (apiKey !== undefined) this.apiKeyOverride = apiKey;
    if (Object.keys(rest).length) {
      if (scope === "project" && !this.project) throw new BetaCodeError("Open a project first.", "NO_PROJECT");
      saveConfig(rest, { scope, home: this.home, projectRoot: this.project?.root });
    }
    this.detectedContext = undefined;
    this.bus.emit({ scope: "app", kind: "config.changed" });
  }

  makeProvider(cfg = this.config()): AIProvider {
    const pc: ProviderConfig = { provider: cfg.provider, baseUrl: cfg.baseUrl, model: cfg.model, apiKey: cfg.apiKey };
    return (this.opts.providerFactory ?? createProvider)(pc);
  }

  async testConnection(): Promise<ConnectionTest> {
    const cfg = this.config();
    const t0 = Date.now();
    try {
      const models = await withTimeout(this.makeProvider(cfg).getModels(), 6000, "Timed out contacting the endpoint");
      const match = models.find((m) => m.id === cfg.model);
      if (match?.contextLength) this.detectedContext = match.contextLength;
      return { ok: true, latencyMs: Date.now() - t0, models: models.map((m) => m.id), modelAvailable: !!match, contextLength: match?.contextLength };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, models: [], modelAvailable: false, error: (e as Error).message };
    }
  }

  // --------------------------------------------------------------- project

  async openProject(path: string): Promise<OpenProjectResult> {
    const root = resolve(path);
    if (!existsSync(root) || !statSync(root).isDirectory()) throw new BetaCodeError(`Not a directory: ${root}`, "NOT_FOUND");
    const info = detectProject(root);
    const record = await this.db.upsertProject(root, info.name, { frameworks: info.frameworks, languages: info.languages, packageManager: info.packageManager, commands: info.commands });
    const ws = new Workspace(root);
    this.project = { record, root: ws.root, info, fs: new FileService(ws, new ChangeTracker(ws)) };
    this.detectedContext = undefined;
    this.bus.emit({ scope: "app", kind: "project.opened" });
    return this.projectSummary();
  }

  async projectSummary(): Promise<OpenProjectResult> {
    const p = this.requireProject();
    const git = new Git(p.root);
    const isRepo = await git.isRepo();
    return {
      record: p.record,
      info: p.info,
      summary: formatProject(p.info),
      instructionFiles: findInstructions(p.root, { home: this.home }).map((f) => f.label),
      git: { isRepo, branch: isRepo ? await git.currentBranch() : null },
    };
  }

  private requireProject(): NonNullable<App["project"]> {
    if (!this.project) throw new BetaCodeError("No project is open.", "NO_PROJECT");
    return this.project;
  }

  listRecentProjects(): Promise<ProjectRecord[]> {
    return this.db.listProjects();
  }

  tree(path = ".", depth = 1): DirEntry {
    return this.requireProject().fs.list(path, { depth, maxEntries: 1000 });
  }

  treeText(path = ".", depth = 3): string {
    return renderTree(this.tree(path, depth));
  }

  readFile(path: string): { path: string; content: string; size: number; language: string; readOnly: boolean } {
    const fs = this.requireProject().fs;
    const abs = fs.ws.resolve(path);
    const rel = fs.ws.rel(abs);
    if (!existsSync(abs)) throw new BetaCodeError(`File not found: ${rel}`, "NOT_FOUND");
    const st = statSync(abs);
    if (st.size > MAX_FILE_VIEW_BYTES) throw new BetaCodeError(`${rel} is too large to open (${st.size} bytes).`, "TOO_LARGE");
    const content = fs.readText(rel);
    return { path: rel, content, size: st.size, language: fs.read(rel, { limit: 1, allowSensitive: true }).language, readOnly: false };
  }

  /** User-initiated save from the editor. */
  saveFile(path: string, content: string): { path: string; size: number } {
    const fs = this.requireProject().fs;
    const abs = fs.ws.resolve(path);
    writeFileSync(abs, content);
    return { path: fs.ws.rel(abs), size: Buffer.byteLength(content) };
  }

  async search(query: string, opts: { regex?: boolean; glob?: string; path?: string } = {}): Promise<{ matches: SearchMatch[]; truncated: boolean }> {
    const r = await searchText(this.requireProject().fs, { query, regex: opts.regex, glob: opts.glob, path: opts.path, maxResults: 200 });
    return { matches: r.matches, truncated: r.truncated };
  }

  quickOpen(pattern: string): string[] {
    return findFiles(this.requireProject().fs, pattern, { maxResults: 50 }).files;
  }

  // ------------------------------------------------------------------- git

  git(): Git {
    return new Git(this.requireProject().root);
  }

  async gitStatus(): Promise<GitStatus | null> {
    const g = this.git();
    return (await g.isRepo()) ? g.status() : null;
  }

  // -------------------------------------------------------------- sessions

  async createSession(input: { title?: string; mode?: AgentMode } = {}): Promise<SessionRecord> {
    const p = this.requireProject();
    const cfg = this.config();
    const rec = await this.db.createSession({ projectId: p.record.id, title: input.title, mode: input.mode, provider: cfg.provider, model: cfg.model });
    this.bus.emit({ scope: "app", kind: "sessions.changed" });
    return rec;
  }

  async listSessions(search?: string): Promise<SessionRecord[]> {
    return this.db.listSessions(this.requireProject().record.id, search);
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.db.renameSession(id, title);
    this.bus.emit({ scope: "app", kind: "sessions.changed" });
  }

  async deleteSession(id: string): Promise<void> {
    const l = this.live_.get(id);
    if (l) {
      l.ctrl?.abort();
      this.broker.denyAll(id);
      await l.done?.catch(() => {});
      await l.queue.catch(() => {});
      this.live_.delete(id);
    }
    await this.db.deleteSession(id);
    this.bus.emit({ scope: "app", kind: "sessions.changed" });
  }

  async duplicateSession(id: string): Promise<SessionRecord> {
    const rec = await this.db.duplicateSession(id);
    this.bus.emit({ scope: "app", kind: "sessions.changed" });
    return rec;
  }

  private async live(id: string): Promise<LiveSession> {
    const existing = this.live_.get(id);
    if (existing) return existing;
    const rec = await this.db.getSession(id);
    if (!rec) throw new BetaCodeError(`Session not found: ${id}`, "NOT_FOUND");
    const proj = await this.db.getProject(rec.projectId);
    if (!proj) throw new BetaCodeError("The session's project no longer exists.", "NOT_FOUND");
    if (!existsSync(proj.path)) throw new BetaCodeError(`Project folder is missing: ${proj.path}`, "NOT_FOUND");

    const messages = await this.db.loadMessages(id);
    const history = buildHistory(rec.summary, rec.foldedCount, messages);
    const stored = await this.db.listFileChanges(id);
    const initial: TrackedChange[] = stored.map((c) => ({ id: c.id, path: c.path, before: c.before, after: c.after, status: c.status, turn: c.turn, updatedAt: c.updatedAt.getTime() }));
    const rules = new CachedRuleStore(await this.db.listRules(proj.path), (tool, decision) => void this.db.setRule(proj.path, tool, decision).catch(() => {}));

    const cfg = this.config();
    const entry: LiveSession = { id, running: false, queue: Promise.resolve(), toolRows: new Map(), titled: rec.title !== "New session", rules, session: undefined as unknown as AgentSession };
    entry.session = new AgentSession({
      root: proj.path,
      config: cfg,
      provider: this.makeProvider(cfg),
      sessionId: id,
      prompter: this.broker.prompterFor(id),
      autoApprove: this.opts.autoApprove,
      rules,
      history,
      plan: rec.plan,
      initialChanges: initial,
      mode: rec.mode as AgentMode,
      home: this.home,
      logger: this.logger,
      onEvent: (e) => this.onAgentEvent(entry, e),
      onChange: (c) => this.enqueue(entry, () => this.db.upsertFileChange(id, c)),
    });
    entry.session.changes.turn = Math.max(0, ...initial.map((c) => c.turn));
    entry.session.agent.foldedTotal = rec.foldedCount;
    this.live_.set(id, entry);
    return entry;
  }

  private enqueue(l: LiveSession, fn: () => Promise<unknown>): void {
    l.queue = l.queue.then(fn).then(
      () => {},
      (e) => this.logger.log("error", "persist.failed", { message: (e as Error).message }),
    );
  }

  private onAgentEvent(l: LiveSession, e: AgentEvent): void {
    this.bus.emit({ scope: "session", sessionId: l.id, event: e });
    switch (e.type) {
      case "agent.message":
        this.enqueue(l, () => this.db.appendMessage(l.id, e.message));
        if (e.message.role === "user" && !l.titled) {
          l.titled = true;
          const title = e.message.content.replace(/\s+/g, " ").trim().slice(0, 60) || "New session";
          this.enqueue(l, async () => {
            await this.db.renameSession(l.id, title);
            this.bus.emit({ scope: "app", kind: "sessions.changed" });
          });
        }
        break;
      case "tool.started":
        l.toolRows.set(e.callId, this.db.recordToolStart(l.id, e.callId, e.name, e.args).catch(() => ""));
        break;
      case "tool.completed": {
        const row = l.toolRows.get(e.callId);
        if (row) {
          l.toolRows.delete(e.callId);
          this.enqueue(l, async () => {
            const id = await row;
            if (id) await this.db.recordToolEnd(id, { ok: e.ok, content: e.content, durationMs: e.durationMs });
          });
        }
        break;
      }
      case "session.compacted":
        this.enqueue(l, () => this.db.saveSessionState(l.id, { summary: e.summary, foldedCount: l.session.agent.foldedTotal }));
        break;
      case "plan.updated":
        this.enqueue(l, () => this.db.saveSessionState(l.id, { plan: e.plan }));
        break;
    }
  }

  async getSession(id: string): Promise<SessionDetail> {
    const rec = await this.db.getSession(id);
    if (!rec) throw new BetaCodeError(`Session not found: ${id}`, "NOT_FOUND");
    const l = this.live_.get(id);
    if (l) await l.queue; // make sure everything emitted so far is readable
    const messages = await this.db.loadMessages(id);
    const toolCalls = (await this.db.listToolCalls(id)).map((t) => ({ callId: t.callId, name: t.name, args: t.args, ok: t.ok, durationMs: t.durationMs, result: t.result }));
    let changes: FileChangeInfo[];
    if (l) changes = l.session.changes.list().map((c) => l.session.changes.toInfo(c));
    else {
      const live = await this.live(id);
      changes = live.session.changes.list().map((c) => live.session.changes.toInfo(c));
    }
    const lv = this.live_.get(id)!;
    return {
      session: await this.db.getSession(id).then((r) => r!),
      messages,
      toolCalls,
      changes,
      running: lv.running,
      plan: lv.session.agent.plan,
      pendingPermissions: this.broker.list(id),
      usage: lv.session.agent.totalUsage,
    };
  }

  /** Start the agent on a message. Returns immediately; progress is delivered via the event bus. */
  async sendMessage(id: string, text: string, opts: { mode?: AgentMode } = {}): Promise<void> {
    if (!text.trim()) throw new BetaCodeError("Message is empty.", "INVALID");
    const l = await this.live(id);
    if (l.running) throw new BetaCodeError("The agent is already working on this session. Stop it first.", "BUSY");
    const cfg = this.config();
    l.session.reconfigure(cfg, this.makeProvider(cfg));
    l.running = true;
    l.ctrl = new AbortController();
    const signal = l.ctrl.signal;
    const mode = opts.mode ?? l.session.agent.mode;
    l.done = (async () => {
      try {
        // Respect the endpoint's real context window when it reports one.
        if (!this.detectedContext) await this.testConnection().catch(() => {});
        l.session.reconfigure(this.config(), this.makeProvider());
        const r = await l.session.run(text, { signal, mode });
        this.enqueue(l, () => this.db.saveSessionState(l.id, { mode, plan: l.session.agent.plan, addUsage: r.usage, model: cfg.model, provider: cfg.provider }));
      } catch (e) {
        const message = (e as Error).message;
        this.logger.log("error", "run.crashed", { message });
        this.bus.emit({ scope: "session", sessionId: l.id, event: { type: "agent.completed", reason: "error", message } });
      } finally {
        l.running = false;
        l.ctrl = undefined;
        this.bus.emit({ scope: "app", kind: "sessions.changed" });
      }
    })();
  }

  async waitForIdle(id: string): Promise<void> {
    const l = this.live_.get(id);
    await l?.done;
    await l?.queue;
  }

  cancel(id: string): boolean {
    const l = this.live_.get(id);
    if (!l?.running) return false;
    l.ctrl?.abort();
    this.broker.denyAll(id);
    return true;
  }

  resolvePermission(requestId: string, decision: PermissionDecision): boolean {
    return this.broker.resolve(requestId, decision);
  }

  async listPermissionRules(): Promise<Array<{ tool: string; decision: "allow" | "deny" }>> {
    return this.db.listRules(this.requireProject().root);
  }

  async deletePermissionRule(tool: string): Promise<void> {
    const root = this.requireProject().root;
    await this.db.deleteRule(root, tool);
    for (const l of this.live_.values()) {
      // Rebuild the cached store contents from the database.
      const rules = await this.db.listRules(root);
      const store = l.rules as unknown as { map: Map<string, PermissionRule> };
      store.map.clear();
      for (const r of rules) store.map.set(r.tool, r);
    }
  }

  // --------------------------------------------------------------- changes

  async changes(id: string): Promise<FileChangeInfo[]> {
    const l = await this.live(id);
    return l.session.changes.list().map((c) => l.session.changes.toInfo(c));
  }

  async acceptChange(id: string, changeId: string): Promise<FileChangeInfo> {
    const l = await this.live(id);
    return l.session.changes.toInfo(l.session.changes.accept(changeId));
  }

  async revertChange(id: string, changeId: string, force = false): Promise<FileChangeInfo> {
    const l = await this.live(id);
    return l.session.changes.toInfo(l.session.changes.revert(changeId, force));
  }

  async acceptAll(id: string): Promise<void> {
    const l = await this.live(id);
    for (const c of l.session.changes.list({ status: "pending" })) l.session.changes.accept(c.id);
  }

  async undo(id: string): Promise<FileChangeInfo | undefined> {
    const l = await this.live(id);
    const c = l.session.changes.undo();
    return c ? l.session.changes.toInfo(c) : undefined;
  }

  async redo(id: string): Promise<FileChangeInfo | undefined> {
    const l = await this.live(id);
    const c = l.session.changes.redo();
    return c ? l.session.changes.toInfo(c) : undefined;
  }

  // ---------------------------------------------------------- slash commands

  async slash(id: string, line: string, mode?: AgentMode): Promise<SlashResult> {
    const [cmd = "", ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ");
    switch (cmd.toLowerCase()) {
      case "/help":
        return { kind: "text", text: HELP_TEXT };
      case "/init":
        await this.sendMessage(id, INIT_PROMPT, { mode: "code" });
        return { kind: "run", started: true };
      case "/compact": {
        const l = await this.live(id);
        if (l.running) throw new BetaCodeError("Stop the agent before compacting.", "BUSY");
        const summary = await l.session.agent.compact();
        return { kind: "text", text: summary ? `Context compacted.\n\n${summary}` : "Nothing to compact yet." };
      }
      case "/clear": {
        const l = await this.live(id);
        if (l.running) throw new BetaCodeError("Stop the agent before clearing.", "BUSY");
        l.session.agent.clear();
        await l.queue;
        await this.db.clearMessages(id);
        return { kind: "text", text: "Conversation cleared. File changes are kept." };
      }
      case "/undo": {
        const c = await this.undo(id);
        return { kind: "text", text: c ? `Reverted ${c.path}.` : "Nothing to undo." };
      }
      case "/redo": {
        const c = await this.redo(id);
        return { kind: "text", text: c ? `Re-applied ${c.path}.` : "Nothing to redo." };
      }
      case "/diff": {
        const ch = await this.changes(id);
        const git = await this.gitStatus();
        const parts = [ch.length ? `Changes in this session:\n${ch.map((c) => `  ${c.kind[0]!.toUpperCase()} ${c.path} (+${c.additions} -${c.deletions}) [${c.status}]`).join("\n")}` : "No changes made by BetaCode in this session."];
        if (git) parts.push(git.clean ? "Git working tree is clean." : formatStatus(git));
        return { kind: "text", text: parts.join("\n\n") };
      }
      case "/status": {
        const cfg = this.config();
        const d = await this.getSession(id);
        const git = await this.gitStatus();
        return {
          kind: "text",
          text: [
            `Project: ${this.requireProject().root}`,
            `Provider: ${cfg.provider}   Model: ${cfg.model}`,
            `Endpoint: ${cfg.baseUrl}`,
            `Context window: ${cfg.contextLength} tokens   Mode: ${d.session.mode}`,
            `Tokens used this session: ${d.usage.inputTokens} in / ${d.usage.outputTokens} out`,
            git ? formatStatus(git) : "Not a git repository.",
          ].join("\n"),
        };
      }
      case "/doctor": {
        const { runDoctor, formatDoctor } = await import("./doctor");
        return { kind: "text", text: formatDoctor(await runDoctor(this)) };
      }
      case "/model":
      case "/provider":
      case "/settings":
        return { kind: "ui", action: "settings" };
      case "/sessions":
        return { kind: "ui", action: "sessions" };
      default:
        void arg;
        void mode;
        throw new BetaCodeError(`Unknown command ${cmd}. Type /help for the list.`, "UNKNOWN_COMMAND");
    }
  }

  // -------------------------------------------------------------- terminal

  /** Run a user-initiated command (full environment) and stream output on the bus. */
  async runTerminal(termId: string, command: string): Promise<void> {
    const p = this.requireProject();
    if (this.terminals.has(termId)) throw new BetaCodeError("A command is already running in this terminal.", "BUSY");
    const ctrl = new AbortController();
    this.terminals.set(termId, ctrl);
    void runCommand({
      command,
      cwd: p.root,
      inheritEnv: true,
      timeoutMs: 30 * 60_000,
      maxOutputBytes: 2_000_000,
      signal: ctrl.signal,
      onOutput: (chunk) => this.bus.emit({ scope: "terminal", id: termId, kind: "output", chunk }),
    }).then((r) => {
      this.terminals.delete(termId);
      this.bus.emit({ scope: "terminal", id: termId, kind: "exit", code: r.exitCode });
    });
  }

  cancelTerminal(termId: string): boolean {
    const c = this.terminals.get(termId);
    c?.abort();
    return !!c;
  }
}

export const HELP_TEXT = [
  "Commands:",
  "  /help      show this list",
  "  /init      analyse the repo and create BETACODE.md (asks permission)",
  "  /compact   summarise older conversation to free context",
  "  /clear     clear the conversation (file changes are kept)",
  "  /diff      list changes made in this session",
  "  /undo      revert the most recent change",
  "  /redo      re-apply the last reverted change",
  "  /status    model, context and git status",
  "  /model, /provider, /settings   open model settings",
  "  /sessions  open the session list",
  "  /doctor    check the environment and model endpoint",
].join("\n");

/** Rebuild the agent's working history from persisted messages (and the compaction summary, if any). */
export function buildHistory(summary: string | null, foldedCount: number, messages: ChatMessage[]): ChatMessage[] {
  const tail = messages.slice(foldedCount);
  if (!summary) return tail;
  const text = `${SUMMARY_MARKER}\n${summary}`;
  if (tail[0]?.role === "user") return [{ role: "user", content: `${text}\n\n---\n\n${tail[0].content}` }, ...tail.slice(1)];
  return [{ role: "user", content: text }, ...tail];
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

