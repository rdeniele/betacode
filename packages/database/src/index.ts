import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { PrismaClient } from "@prisma/client";
import type { ChatMessage, PlanItem, ToolCallRequest } from "@betacode/shared";
import { redactText } from "@betacode/shared";
import { INIT_SQL } from "./init-sql";

export interface ProjectRecord {
  id: string;
  path: string;
  name: string;
  metadata: unknown;
  lastOpened: Date;
}

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  mode: string;
  provider: string;
  model: string;
  summary: string | null;
  foldedCount: number;
  plan: PlanItem[];
  inputTokens: number;
  outputTokens: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FileChangeRecord {
  id: string;
  path: string;
  before: string | null;
  after: string | null;
  status: "pending" | "accepted" | "reverted";
  turn: number;
  updatedAt: Date;
}

export interface ToolCallRecord {
  id: string;
  callId: string;
  name: string;
  args: string;
  result: string | null;
  ok: boolean | null;
  durationMs: number | null;
  createdAt: Date;
}

const SCHEMA_VERSION = 1;

function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** All SQLite access lives here. Callers never touch Prisma directly. */
export class Database {
  private constructor(readonly prisma: PrismaClient) {}

  /** Open (creating if necessary) the database file. Use ":memory:"-style paths only in tests via a temp file. */
  static async open(file: string): Promise<Database> {
    mkdirSync(dirname(file), { recursive: true });
    const url = `file:${file.replace(/\\/g, "/")}`;
    const prisma = new PrismaClient({ datasourceUrl: url, log: [] });
    const db = new Database(prisma);
    await db.ensureSchema();
    return db;
  }

  private async ensureSchema(): Promise<void> {
    const rows = await this.prisma.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM sqlite_master WHERE type='table' AND name='Session'`);
    if (rows.length === 0) {
      const statements = INIT_SQL.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^--[^\n]*$/.test(s));
      for (const stmt of statements) {
        const clean = stmt.replace(/^(--[^\n]*\n)+/g, "").trim();
        if (clean) await this.prisma.$executeRawUnsafe(clean);
      }
      await this.prisma.$executeRawUnsafe(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
  }

  async close(): Promise<void> {
    await this.prisma.$disconnect();
  }

  // ---- projects ----
  async upsertProject(path: string, name: string, metadata?: unknown): Promise<ProjectRecord> {
    const p = await this.prisma.project.upsert({
      where: { path },
      create: { path, name, metadata: metadata ? JSON.stringify(metadata) : null },
      update: { name, lastOpened: new Date(), ...(metadata ? { metadata: JSON.stringify(metadata) } : {}) },
    });
    return { id: p.id, path: p.path, name: p.name, metadata: parseJson(p.metadata, null), lastOpened: p.lastOpened };
  }

  async getProject(id: string): Promise<ProjectRecord | undefined> {
    const p = await this.prisma.project.findUnique({ where: { id } });
    return p ? { id: p.id, path: p.path, name: p.name, metadata: parseJson(p.metadata, null), lastOpened: p.lastOpened } : undefined;
  }

  async listProjects(): Promise<ProjectRecord[]> {
    const rows = await this.prisma.project.findMany({ orderBy: { lastOpened: "desc" } });
    return rows.map((p) => ({ id: p.id, path: p.path, name: p.name, metadata: parseJson(p.metadata, null), lastOpened: p.lastOpened }));
  }

  // ---- sessions ----
  private toSession(s: any): SessionRecord {
    return { ...s, plan: parseJson<PlanItem[]>(s.plan, []) };
  }

  async createSession(input: { projectId: string; title?: string; mode?: string; provider: string; model: string }): Promise<SessionRecord> {
    const s = await this.prisma.session.create({
      data: { projectId: input.projectId, title: input.title ?? "New session", mode: input.mode ?? "code", provider: input.provider, model: input.model },
    });
    return this.toSession(s);
  }

  async getSession(id: string): Promise<SessionRecord | undefined> {
    const s = await this.prisma.session.findUnique({ where: { id } });
    return s ? this.toSession(s) : undefined;
  }

  async listSessions(projectId: string, search?: string): Promise<SessionRecord[]> {
    const q = search?.trim();
    const rows = await this.prisma.session.findMany({
      where: {
        projectId,
        ...(q ? { OR: [{ title: { contains: q } }, { messages: { some: { content: { contains: q } } } }] } : {}),
      },
      orderBy: { updatedAt: "desc" },
    });
    return rows.map((r) => this.toSession(r));
  }

  async renameSession(id: string, title: string): Promise<void> {
    await this.prisma.session.update({ where: { id }, data: { title: title.trim().slice(0, 200) || "Untitled" } });
  }

  async deleteSession(id: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { id } });
  }

  async duplicateSession(id: string): Promise<SessionRecord> {
    const src = await this.prisma.session.findUniqueOrThrow({ where: { id }, include: { messages: { orderBy: { seq: "asc" } } } });
    const copy = await this.prisma.session.create({
      data: {
        projectId: src.projectId,
        title: `${src.title} (copy)`,
        mode: src.mode,
        provider: src.provider,
        model: src.model,
        summary: src.summary,
        foldedCount: src.foldedCount,
        plan: src.plan,
        messages: {
          create: src.messages.map((m) => ({ seq: m.seq, role: m.role, content: m.content, toolCallsJson: m.toolCallsJson, toolCallId: m.toolCallId, name: m.name })),
        },
      },
    });
    return this.toSession(copy);
  }

  async saveSessionState(id: string, state: { summary?: string | null; foldedCount?: number; plan?: PlanItem[]; mode?: string; model?: string; provider?: string; addUsage?: { inputTokens: number; outputTokens: number } }): Promise<void> {
    await this.prisma.session.update({
      where: { id },
      data: {
        ...(state.summary !== undefined ? { summary: state.summary } : {}),
        ...(state.foldedCount !== undefined ? { foldedCount: state.foldedCount } : {}),
        ...(state.plan !== undefined ? { plan: JSON.stringify(state.plan) } : {}),
        ...(state.mode ? { mode: state.mode } : {}),
        ...(state.model ? { model: state.model } : {}),
        ...(state.provider ? { provider: state.provider } : {}),
        ...(state.addUsage ? { inputTokens: { increment: state.addUsage.inputTokens }, outputTokens: { increment: state.addUsage.outputTokens } } : {}),
      },
    });
  }

  // ---- messages ----
  async appendMessage(sessionId: string, m: ChatMessage): Promise<void> {
    const last = await this.prisma.message.findFirst({ where: { sessionId }, orderBy: { seq: "desc" }, select: { seq: true } });
    await this.prisma.message.create({
      data: {
        sessionId,
        seq: (last?.seq ?? -1) + 1,
        role: m.role,
        content: m.content,
        toolCallsJson: m.toolCalls ? JSON.stringify(m.toolCalls) : null,
        toolCallId: m.toolCallId ?? null,
        name: m.name ?? null,
      },
    });
    await this.prisma.session.update({ where: { id: sessionId }, data: { updatedAt: new Date() } });
  }

  async clearMessages(sessionId: string): Promise<void> {
    await this.prisma.message.deleteMany({ where: { sessionId } });
    await this.prisma.session.update({ where: { id: sessionId }, data: { summary: null, foldedCount: 0, plan: null } });
  }

  async loadMessages(sessionId: string): Promise<ChatMessage[]> {
    const rows = await this.prisma.message.findMany({ where: { sessionId }, orderBy: { seq: "asc" } });
    return rows.map((r) => {
      const m: ChatMessage = { role: r.role as ChatMessage["role"], content: r.content };
      const calls = parseJson<ToolCallRequest[] | null>(r.toolCallsJson, null);
      if (calls) m.toolCalls = calls;
      if (r.toolCallId) m.toolCallId = r.toolCallId;
      if (r.name) m.name = r.name;
      return m;
    });
  }

  // ---- tool calls ----
  async recordToolStart(sessionId: string, callId: string, name: string, args: unknown): Promise<string> {
    const row = await this.prisma.toolCall.create({ data: { sessionId, callId, name, args: redactText(JSON.stringify(args ?? null)) } });
    return row.id;
  }

  async recordToolEnd(rowId: string, result: { ok: boolean; content: string; durationMs: number }): Promise<void> {
    await this.prisma.toolCall.update({ where: { id: rowId }, data: { ok: result.ok, result: redactText(result.content).slice(0, 20000), durationMs: result.durationMs } });
  }

  async listToolCalls(sessionId: string): Promise<ToolCallRecord[]> {
    return this.prisma.toolCall.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
  }

  // ---- file changes ----
  async upsertFileChange(sessionId: string, c: { id: string; path: string; before: string | null; after: string | null; status: string; turn: number }): Promise<void> {
    await this.prisma.fileChange.upsert({
      where: { id: c.id },
      create: { id: c.id, sessionId, path: c.path, before: c.before, after: c.after, status: c.status, turn: c.turn },
      update: { after: c.after, status: c.status, turn: c.turn },
    });
  }

  async listFileChanges(sessionId: string): Promise<FileChangeRecord[]> {
    const rows = await this.prisma.fileChange.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
    return rows.map((r) => ({ id: r.id, path: r.path, before: r.before, after: r.after, status: r.status as FileChangeRecord["status"], turn: r.turn, updatedAt: r.updatedAt }));
  }

  // ---- permission rules ----
  async listRules(scope: string): Promise<Array<{ tool: string; decision: "allow" | "deny" }>> {
    const rows = await this.prisma.permissionRule.findMany({ where: { scope: { in: ["global", scope] } } });
    return rows.map((r) => ({ tool: r.tool, decision: r.decision as "allow" | "deny" }));
  }

  async setRule(scope: string, tool: string, decision: "allow" | "deny"): Promise<void> {
    await this.prisma.permissionRule.upsert({ where: { scope_tool: { scope, tool } }, create: { scope, tool, decision }, update: { decision } });
  }

  async deleteRule(scope: string, tool: string): Promise<void> {
    await this.prisma.permissionRule.deleteMany({ where: { scope, tool } });
  }

  // ---- preferences ----
  async getPreference(key: string): Promise<string | undefined> {
    return (await this.prisma.userPreference.findUnique({ where: { key } }))?.value;
  }

  async setPreference(key: string, value: string): Promise<void> {
    await this.prisma.userPreference.upsert({ where: { key }, create: { key, value }, update: { value } });
  }
}

export { INIT_SQL };
