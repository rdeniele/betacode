import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../lib/types";

const emit: { current?: (e: ServerEvent) => void } = {};

vi.mock("../lib/api", () => {
  class ApiError extends Error {
    constructor(
      m: string,
      readonly status = 500,
      readonly code = "ERROR",
    ) {
      super(m);
    }
  }
  const api = {
    state: vi.fn(async () => ({ project: null, config: { model: "m", provider: "qwen", baseUrl: "http://x/v1", hasApiKey: false, contextLength: 32768, permissions: {} } })),
    openProject: vi.fn(async (path: string) => ({ record: { id: "p1", path, name: "demo" }, info: { name: "demo", root: path, languages: ["TypeScript"], frameworks: [], database: [], orm: [], auth: [], testFrameworks: [], commands: [], entryPoints: [], importantDirs: [], isGitRepo: true }, summary: "", instructionFiles: [], git: { isRepo: true, branch: "main" } })),
    sessions: vi.fn(async () => [] as unknown[]),
    createSession: vi.fn(async () => ({ id: "s1", title: "New session", mode: "code", updatedAt: new Date().toISOString() })),
    session: vi.fn(async (id: string) => ({ session: { id, title: "New session", mode: "code" }, messages: [], toolCalls: [], changes: [], running: false, plan: [], pendingPermissions: [], usage: { inputTokens: 0, outputTokens: 0 } })),
    gitStatus: vi.fn(async () => ({ status: null })),
    config: vi.fn(async () => ({ model: "m" })),
    send: vi.fn(async () => ({ kind: "run", started: true })),
    cancel: vi.fn(async () => ({ cancelled: true })),
    decide: vi.fn(async () => ({ resolved: true })),
    changes: vi.fn(async () => []),
    acceptChange: vi.fn(),
    revertChange: vi.fn(),
    readFile: vi.fn(async (path: string) => ({ path, content: "const a = 1;", size: 12, language: "typescript" })),
    saveFile: vi.fn(async (path: string) => ({ path, size: 1 })),
  };
  return {
    api,
    ApiError,
    subscribeEvents: (cb: (e: ServerEvent) => void, status?: (ok: boolean) => void) => {
      emit.current = cb;
      status?.(true);
      return () => {};
    },
  };
});

import { api } from "../lib/api";
import { useApp } from "./app";

const session = (event: Extract<ServerEvent, { scope: "session" }>["event"]): ServerEvent => ({ scope: "session", sessionId: "s1", event });

beforeEach(async () => {
  useApp.setState({ rightPanelOpen: false, rightTab: "changes" });
  vi.clearAllMocks();
  useApp.setState({ project: undefined, activeId: undefined, items: [], plan: [], changes: [], pending: [], running: false, agentState: "IDLE", tabs: [], toasts: [], sessions: [] });
  useApp.getState().init();
  await useApp.getState().openProject("/work/demo");
});

describe("app store", () => {
  it("opening a project creates a first session when none exist", async () => {
    expect(api.openProject).toHaveBeenCalledWith("/work/demo");
    expect(api.createSession).toHaveBeenCalledTimes(1);
    expect(useApp.getState()).toMatchObject({ activeId: "s1", dialog: null });
    expect(useApp.getState().project?.info.name).toBe("demo");
  });

  it("newSession creates and selects a session", async () => {
    vi.mocked(api.createSession).mockResolvedValueOnce({ id: "s2", title: "New session", mode: "code" } as never);
    await useApp.getState().newSession();
    expect(useApp.getState().activeId).toBe("s2");
  });

  it("tracks agent state, streaming text, tool lifecycle and completion from live events", () => {
    const push = (e: Extract<ServerEvent, { scope: "session" }>["event"]) => emit.current!(session(e));
    push({ type: "agent.started", sessionId: "s1", mode: "code" });
    expect(useApp.getState()).toMatchObject({ running: true, agentState: "THINKING" });
    push({ type: "agent.state", state: "READING", detail: "Read a.ts" });
    push({ type: "agent.text", delta: "Looking" });
    push({ type: "tool.started", callId: "c1", name: "read_file", args: { path: "a.ts" } });
    push({ type: "tool.completed", callId: "c1", name: "read_file", ok: true, content: "1\tx", durationMs: 3 });
    expect(useApp.getState().agentState).toBe("READING");
    expect(useApp.getState().items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    push({ type: "usage", usage: { inputTokens: 100, outputTokens: 10 }, contextTokens: 100, contextLimit: 32768, steps: 1 });
    expect(useApp.getState().usage).toMatchObject({ inputTokens: 100, steps: 1, contextLimit: 32768 });
    push({ type: "agent.completed", reason: "completed" });
    expect(useApp.getState()).toMatchObject({ running: false, agentState: "COMPLETED" });
  });

  it("ignores events for other sessions", () => {
    emit.current!({ scope: "session", sessionId: "other", event: { type: "agent.started", sessionId: "other", mode: "code" } });
    expect(useApp.getState().running).toBe(false);
  });

  it("queues permission requests and clears them when resolved or when the run ends", async () => {
    const req = { id: "r1", tool: "write_file", summary: "Create a.txt", riskLevel: "confirm" as const, grantKey: "write_file" };
    emit.current!(session({ type: "permission.requested", request: req }));
    expect(useApp.getState().pending).toHaveLength(1);
    await useApp.getState().decide("r1", "allow_once");
    expect(api.decide).toHaveBeenCalledWith("r1", "allow_once");
    expect(useApp.getState().pending).toHaveLength(0);
    emit.current!(session({ type: "permission.requested", request: req }));
    emit.current!(session({ type: "agent.completed", reason: "cancelled" }));
    expect(useApp.getState().pending).toHaveLength(0);
  });

  it("keeps the changes list in sync and updates by id", () => {
    const c = { id: "c1", path: "b.ts", kind: "modified" as const, status: "pending" as const, turn: 1, additions: 1, deletions: 0, diff: "+x" };
    emit.current!(session({ type: "file.changed", change: c }));
    emit.current!(session({ type: "file.changed", change: { ...c, additions: 5 } }));
    emit.current!(session({ type: "file.changed", change: { ...c, id: "c0", path: "a.ts" } }));
    expect(useApp.getState().changes.map((x) => [x.path, x.additions])).toEqual([["a.ts", 1], ["b.ts", 5]]);
  });

  it("sends the current mode with messages and surfaces send failures in the transcript", async () => {
    useApp.getState().setMode("plan");
    await useApp.getState().send("Add auth");
    expect(api.send).toHaveBeenCalledWith("s1", "Add auth", "plan");
    vi.mocked(api.send).mockRejectedValueOnce(new Error("busy"));
    await useApp.getState().send("again");
    expect(useApp.getState().items.at(-1)).toMatchObject({ kind: "notice", tone: "error", text: "busy" });
  });

  it("opens, edits and saves files in editor tabs and tracks unsaved changes", async () => {
    await useApp.getState().openFile("src/a.ts");
    expect(useApp.getState()).toMatchObject({ activeTab: "src/a.ts", rightTab: "editor", rightPanelOpen: true });
    useApp.getState().editTab("src/a.ts", "const a = 2;");
    expect(useApp.getState().tabs[0]).toMatchObject({ content: "const a = 2;", saved: "const a = 1;" });
    await useApp.getState().saveTab("src/a.ts");
    expect(api.saveFile).toHaveBeenCalledWith("src/a.ts", "const a = 2;");
    expect(useApp.getState().tabs[0]!.saved).toBe("const a = 2;");
    useApp.getState().closeTab("src/a.ts");
    expect(useApp.getState().tabs).toHaveLength(0);
  });

  it("reloads an open, unmodified tab when the agent changes that file", async () => {
    await useApp.getState().openFile("src/a.ts");
    vi.mocked(api.readFile).mockClear();
    emit.current!(session({ type: "file.changed", change: { id: "c", path: "src/a.ts", kind: "modified", status: "pending", turn: 1, additions: 1, deletions: 1, diff: "" } }));
    expect(api.readFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("refreshes agent edits without reopening details or switching the selected tab", async () => {
    await useApp.getState().openFile("src/a.ts");
    useApp.setState({ rightPanelOpen: false, rightTab: "changes" });
    vi.mocked(api.readFile).mockResolvedValueOnce({ path: "src/a.ts", content: "const a = 3;", size: 12, language: "typescript" });
    emit.current!(session({ type: "file.changed", change: { id: "c", path: "src/a.ts", kind: "modified", status: "pending", turn: 1, additions: 1, deletions: 1, diff: "" } }));
    await vi.waitFor(() => expect(useApp.getState().tabs[0]?.content).toBe("const a = 3;"));
    expect(useApp.getState()).toMatchObject({ rightPanelOpen: false, rightTab: "changes" });
  });
});
