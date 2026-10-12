import { create } from "zustand";
import { api, ApiError, subscribeEvents } from "../lib/api";
import { applyEvent, itemsFromMessages, notice, type ChatItem } from "../lib/chat";
import { applyAppearance, loadAppearance, saveAppearance, type Appearance } from "../lib/appearance";
import { setupBus } from "../lib/setup-bus";
import { terminalBus } from "../lib/terminal-bus";
import type {
  AgentMode,
  AgentEvent,
  FileChangeInfo,
  GitStatus,
  OpenProject,
  PermissionDecision,
  PermissionRequest,
  PlanItem,
  PublicConfig,
  ServerEvent,
  SessionRecord,
} from "../lib/types";

export type LeftTab = "files" | "sessions";
export type RightTab = "changes" | "editor" | "git" | "context";
export type Dialog = null | "open-project" | "settings" | "palette" | "quick-open" | "search";
export type SettingsTab = "models" | "helper" | "local" | "appearance" | "permissions" | "doctor";

export interface EditorTab {
  path: string;
  language: string;
  content: string;
  saved: string;
}

export interface Toast {
  id: number;
  tone: "info" | "error" | "success";
  text: string;
}

interface UsageInfo {
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  contextLimit: number;
  steps: number;
}

interface State {
  connection: "connecting" | "online" | "offline";
  config?: PublicConfig;
  project?: OpenProject;
  git?: GitStatus | null;
  sessions: SessionRecord[];
  activeId?: string;
  items: ChatItem[];
  plan: PlanItem[];
  changes: FileChangeInfo[];
  pending: PermissionRequest[];
  agentState: string;
  agentDetail?: string;
  running: boolean;
  usage: UsageInfo;
  mode: AgentMode;
  leftTab: LeftTab;
  rightTab: RightTab;
  rightPanelOpen: boolean;
  terminalOpen: boolean;
  dialog: Dialog;
  settingsTab: SettingsTab;
  tabs: EditorTab[];
  activeTab?: string;
  selectedChange?: string;
  toasts: Toast[];
  treeVersion: number;
  appearance: Appearance;
  sidebarOpen: boolean;
  /** Models the configured endpoint reports (for the model picker). */
  availableModels: string[];
  modelStatus: "unknown" | "connected" | "unreachable";

  setAppearance(p: Partial<Appearance>): void;
  refreshModels(): Promise<void>;
  setModel(id: string): Promise<void>;
  init(): () => void;
  openProject(path: string): Promise<boolean>;
  refreshSessions(search?: string): Promise<void>;
  refreshGit(): Promise<void>;
  refreshConfig(): Promise<void>;
  selectSession(id: string): Promise<void>;
  newSession(): Promise<void>;
  deleteSession(id: string): Promise<void>;
  renameSession(id: string, title: string): Promise<void>;
  duplicateSession(id: string): Promise<void>;
  send(text: string): Promise<void>;
  cancel(): Promise<void>;
  decide(id: string, decision: PermissionDecision): Promise<void>;
  acceptChange(id: string): Promise<void>;
  revertChange(id: string): Promise<void>;
  acceptAll(): Promise<void>;
  undo(): Promise<void>;
  redo(): Promise<void>;
  openFile(path: string, reveal?: boolean): Promise<void>;
  closeTab(path: string): void;
  editTab(path: string, content: string): void;
  saveTab(path: string): Promise<void>;
  setMode(m: AgentMode): void;
  set(p: Partial<State>): void;
  toast(text: string, tone?: Toast["tone"]): void;
  dismissToast(id: number): void;
}

const emptyUsage: UsageInfo = { inputTokens: 0, outputTokens: 0, contextTokens: 0, contextLimit: 0, steps: 0 };
let toastId = 0;

const errMsg = (e: unknown) => (e instanceof ApiError || e instanceof Error ? e.message : String(e));

export const useApp = create<State>((set, get) => {
  const handleSessionEvent = (e: AgentEvent) => {
    set((s) => {
      const next: Partial<State> = { items: applyEvent(s.items, e) };
      switch (e.type) {
        case "agent.started":
          next.running = true;
          next.agentState = "THINKING";
          break;
        case "agent.state":
          next.agentState = e.state;
          next.agentDetail = e.detail;
          break;
        case "agent.completed":
          next.running = false;
          next.agentState = e.reason === "completed" || e.reason === "permission_denied" ? "COMPLETED" : e.reason === "cancelled" ? "CANCELLED" : "FAILED";
          next.pending = [];
          break;
        case "permission.requested":
          next.pending = [...s.pending.filter((p) => p.id !== e.request.id), e.request];
          break;
        case "permission.resolved":
          next.pending = s.pending.filter((p) => p.id !== e.requestId);
          break;
        case "file.changed":
          next.changes = [...s.changes.filter((c) => c.id !== e.change.id), e.change].sort((a, b) => a.path.localeCompare(b.path));
          break;
        case "plan.updated":
          next.plan = e.plan;
          break;
        case "usage":
          next.usage = { inputTokens: e.usage.inputTokens, outputTokens: e.usage.outputTokens, contextTokens: e.contextTokens, contextLimit: e.contextLimit, steps: e.steps };
          break;
      }
      return next;
    });
    if (e.type === "file.changed") {
      // Keep open editor tabs in sync with what the agent wrote (unless the user has unsaved edits).
      const tab = get().tabs.find((t) => t.path === e.change.path);
      if (tab && tab.content === tab.saved) void get().openFile(e.change.path, false);
      set((s) => ({ treeVersion: s.treeVersion + 1 }));
    }
    if (e.type === "agent.completed") void get().refreshGit();
  };

  const handleEvent = (ev: ServerEvent) => {
    if (ev.scope === "session") {
      if (ev.sessionId === get().activeId) handleSessionEvent(ev.event);
    } else if (ev.scope === "setup") {
      setupBus.emit(ev);
    } else if (ev.scope === "terminal") {
      terminalBus.emit({ id: ev.id, kind: ev.kind, chunk: ev.chunk, code: ev.code });
    } else if (ev.kind === "sessions.changed") void get().refreshSessions();
    else if (ev.kind === "config.changed") {
      void get().refreshConfig();
      void get().refreshModels();
    }
  };

  return {
    connection: "connecting",
    sessions: [],
    items: [],
    plan: [],
    changes: [],
    pending: [],
    agentState: "IDLE",
    running: false,
    usage: emptyUsage,
    mode: "code",
    leftTab: "files",
    rightTab: "changes",
    rightPanelOpen: false,
    terminalOpen: false,
    dialog: null,
    settingsTab: "models",
    tabs: [],
    toasts: [],
    treeVersion: 0,
    appearance: loadAppearance(),
    sidebarOpen: true,
    availableModels: [],
    modelStatus: "unknown",

    setAppearance(p) {
      const next = { ...get().appearance, ...p };
      applyAppearance(next);
      saveAppearance(next);
      set({ appearance: next });
    },

    async refreshModels() {
      try {
        const t = await api.testConnection();
        set({ availableModels: t.ok ? t.models : [], modelStatus: t.ok ? "connected" : "unreachable" });
      } catch {
        set({ availableModels: [], modelStatus: "unreachable" });
      }
    },

    async setModel(id) {
      try {
        await api.updateConfig({ model: id });
        await get().refreshConfig();
      } catch (e) {
        get().toast(errMsg(e), "error");
      }
    },

    init() {
      applyAppearance(get().appearance);
      const off = subscribeEvents(handleEvent, (ok) => {
        set({ connection: ok ? "online" : "offline" });
        if (ok) {
          void get().refreshModels();
          void api
            .state()
            .then(async (st) => {
              set({ config: st.config });
              if (st.project && !get().project) {
                set({ project: st.project });
                await get().refreshSessions();
                void get().refreshGit();
                if (!get().activeId) {
                  const latest = get().sessions[0];
                  if (latest) await get().selectSession(latest.id);
                  else await get().newSession();
                }
              }
            })
            .catch(() => {});
        }
      });
      return off;
    },

    async openProject(path) {
      try {
        const project = await api.openProject(path);
        set({ project, activeId: undefined, items: [], plan: [], changes: [], pending: [], tabs: [], activeTab: undefined, dialog: null, running: false, agentState: "IDLE", usage: emptyUsage, treeVersion: get().treeVersion + 1 });
        await get().refreshSessions();
        await get().refreshGit();
        const sessions = get().sessions;
        if (sessions[0]) await get().selectSession(sessions[0].id);
        else await get().newSession();
        void get().refreshConfig();
        return true;
      } catch (e) {
        get().toast(errMsg(e), "error");
        return false;
      }
    },

    async refreshSessions(search) {
      try {
        set({ sessions: await api.sessions(search) });
      } catch {
        /* no project open yet */
      }
    },

    async refreshGit() {
      try {
        set({ git: (await api.gitStatus()).status });
      } catch {
        set({ git: null });
      }
    },

    async refreshConfig() {
      try {
        set({ config: await api.config() });
      } catch {
        /* offline */
      }
    },

    async selectSession(id) {
      try {
        const d = await api.session(id);
        set({
          activeId: id,
          items: itemsFromMessages(d.messages),
          plan: d.plan,
          changes: d.changes,
          pending: d.pendingPermissions,
          running: d.running,
          agentState: d.running ? "THINKING" : "IDLE",
          mode: d.session.mode,
          usage: { ...emptyUsage, inputTokens: d.usage.inputTokens, outputTokens: d.usage.outputTokens, contextLimit: get().config?.contextLength ?? 0 },
          selectedChange: undefined,
        });
      } catch (e) {
        get().toast(errMsg(e), "error");
      }
    },

    async newSession() {
      try {
        const s = await api.createSession(get().mode);
        await get().refreshSessions();
        await get().selectSession(s.id);
        set({ leftTab: "files" });
      } catch (e) {
        get().toast(errMsg(e), "error");
      }
    },

    async deleteSession(id) {
      await api.deleteSession(id);
      await get().refreshSessions();
      if (get().activeId === id) {
        const next = get().sessions[0];
        if (next) await get().selectSession(next.id);
        else await get().newSession();
      }
    },

    async renameSession(id, title) {
      await api.renameSession(id, title);
      await get().refreshSessions();
    },

    async duplicateSession(id) {
      const copy = await api.duplicateSession(id);
      await get().refreshSessions();
      await get().selectSession(copy.id);
    },

    async send(text) {
      const id = get().activeId;
      if (!id || !text.trim()) return;
      try {
        const r = await api.send(id, text, get().mode);
        const cmd = text.trim().split(/s+/)[0]!.toLowerCase();
        if (r.kind === "text") {
          set((s) => ({ items: cmd === "/clear" ? notice([], r.text) : notice(s.items, r.text), plan: cmd === "/clear" ? [] : s.plan }));
          if (["/compact", "/undo", "/redo"].includes(cmd)) {
            set({ changes: await api.changes(id), treeVersion: get().treeVersion + 1 });
            void get().refreshGit();
          }
        } else if (r.kind === "ui") {
          set(r.action === "sessions" ? { leftTab: "sessions" } : { dialog: "settings", settingsTab: "models" });
        }
      } catch (e) {
        set((s) => ({ items: notice(s.items, errMsg(e), "error") }));
      }
    },

    async cancel() {
      const id = get().activeId;
      if (id) await api.cancel(id).catch(() => {});
    },

    async decide(requestId, decision) {
      set((s) => ({ pending: s.pending.filter((p) => p.id !== requestId) }));
      await api.decide(requestId, decision).catch((e) => get().toast(errMsg(e), "error"));
    },

    async acceptChange(changeId) {
      const id = get().activeId;
      if (!id) return;
      const c = await api.acceptChange(id, changeId).catch((e) => (get().toast(errMsg(e), "error"), undefined));
      if (c) set((s) => ({ changes: s.changes.map((x) => (x.id === c.id ? c : x)) }));
    },

    async revertChange(changeId) {
      const id = get().activeId;
      if (!id) return;
      try {
        const c = await api.revertChange(id, changeId);
        set((s) => ({ changes: s.changes.map((x) => (x.id === c.id ? c : x)), treeVersion: s.treeVersion + 1 }));
        const tab = get().tabs.find((t) => t.path === c.path);
        if (tab) void get().openFile(c.path, false);
        void get().refreshGit();
      } catch (e) {
        get().toast(errMsg(e), "error");
      }
    },

    async acceptAll() {
      const id = get().activeId;
      if (!id) return;
      await api.acceptAll(id);
      set({ changes: await api.changes(id) });
    },

    async undo() {
      const id = get().activeId;
      if (!id) return;
      await api.undo(id);
      set({ changes: await api.changes(id), treeVersion: get().treeVersion + 1 });
      void get().refreshGit();
    },

    async redo() {
      const id = get().activeId;
      if (!id) return;
      await api.redo(id);
      set({ changes: await api.changes(id), treeVersion: get().treeVersion + 1 });
      void get().refreshGit();
    },

    async openFile(path, reveal = true) {
      try {
        const f = await api.readFile(path);
        set((s) => {
          const tab: EditorTab = { path: f.path, language: f.language, content: f.content, saved: f.content };
          const exists = s.tabs.some((t) => t.path === f.path);
          return { tabs: exists ? s.tabs.map((t) => (t.path === f.path ? tab : t)) : [...s.tabs, tab], ...(reveal ? { activeTab: f.path, rightTab: "editor" as const, rightPanelOpen: true } : {}) };
        });
      } catch (e) {
        get().toast(errMsg(e), "error");
      }
    },

    closeTab(path) {
      set((s) => {
        const tabs = s.tabs.filter((t) => t.path !== path);
        return { tabs, activeTab: s.activeTab === path ? tabs[tabs.length - 1]?.path : s.activeTab };
      });
    },

    editTab(path, content) {
      set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, content } : t)) }));
    },

    async saveTab(path) {
      const tab = get().tabs.find((t) => t.path === path);
      if (!tab) return;
      try {
        await api.saveFile(path, tab.content);
        set((s) => ({ tabs: s.tabs.map((t) => (t.path === path ? { ...t, saved: t.content } : t)) }));
        void get().refreshGit();
      } catch (e) {
        get().toast(errMsg(e), "error");
      }
    },

    setMode(mode) {
      set({ mode });
    },

    set(p) {
      set(p);
    },

    toast(text, tone = "info") {
      const id = ++toastId;
      set((s) => ({ toasts: [...s.toasts, { id, tone, text }] }));
      setTimeout(() => get().dismissToast(id), tone === "error" ? 8000 : 4000);
    },

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },
  };
});
