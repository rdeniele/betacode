import type {
  ConnectionTest,
  DirEntry,
  DoctorCheck,
  FileChangeInfo,
  GitStatus,
  OpenProject,
  PermissionDecision,
  PublicConfig,
  SearchMatch,
  ServerEvent,
  SessionDetail,
  SessionRecord,
  SlashResult,
} from "./types";

export const API_BASE: string = (import.meta.env?.VITE_BETACODE_API as string | undefined) ?? "http://127.0.0.1:4317";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Cannot reach the BetaCode runtime. Start it with `pnpm server`.", 0, "OFFLINE");
  }
  const json = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } } & T;
  if (!res.ok) throw new ApiError(json.error?.message ?? `HTTP ${res.status}`, res.status, json.error?.code ?? "ERROR");
  return json as T;
}

const q = (params: Record<string, string | number | boolean | undefined>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v === true ? 1 : v));
  const s = p.toString();
  return s ? `?${s}` : "";
};

export const api = {
  health: () => request<{ ok: boolean }>("GET", "/api/health"),
  state: () => request<{ project: OpenProject | null; config: PublicConfig }>("GET", "/api/state"),
  recentProjects: () => request<Array<{ id: string; path: string; name: string }>>("GET", "/api/projects"),
  openProject: (path: string) => request<OpenProject>("POST", "/api/project/open", { path }),
  tree: (path = ".", depth = 1) => request<DirEntry>("GET", `/api/tree${q({ path, depth })}`),
  readFile: (path: string) => request<{ path: string; content: string; size: number; language: string }>("GET", `/api/file${q({ path })}`),
  saveFile: (path: string, content: string) => request<{ path: string; size: number }>("PUT", "/api/file", { path, content }),
  search: (query: string, regex = false) => request<{ matches: SearchMatch[]; truncated: boolean }>("GET", `/api/search${q({ q: query, regex })}`),
  quickOpen: (query: string) => request<{ files: string[] }>("GET", `/api/quick-open${q({ q: query })}`),

  gitStatus: () => request<{ status: GitStatus | null }>("GET", "/api/git/status"),
  gitDiff: (opts: { path?: string; staged?: boolean } = {}) => request<{ diff: string }>("GET", `/api/git/diff${q(opts)}`),
  gitLog: () => request<{ commits: Array<{ shortHash: string; subject: string; author: string; date: string }> }>("GET", "/api/git/log"),
  gitAdd: (paths: string[]) => request("POST", "/api/git/add", { paths }),
  gitCommit: (message: string) => request<{ hash: string; summary: string }>("POST", "/api/git/commit", { message }),
  gitPush: () => request<{ output: string }>("POST", "/api/git/push"),
  gitPull: () => request<{ output: string }>("POST", "/api/git/pull"),

  sessions: (search?: string) => request<SessionRecord[]>("GET", `/api/sessions${q({ q: search })}`),
  createSession: (mode?: string) => request<SessionRecord>("POST", "/api/sessions", { mode }),
  session: (id: string) => request<SessionDetail>("GET", `/api/sessions/${id}`),
  renameSession: (id: string, title: string) => request("PATCH", `/api/sessions/${id}`, { title }),
  deleteSession: (id: string) => request("DELETE", `/api/sessions/${id}`),
  duplicateSession: (id: string) => request<SessionRecord>("POST", `/api/sessions/${id}/duplicate`),
  send: (id: string, text: string, mode?: string) => request<SlashResult>("POST", `/api/sessions/${id}/messages`, { text, mode }),
  cancel: (id: string) => request<{ cancelled: boolean }>("POST", `/api/sessions/${id}/cancel`),
  changes: (id: string) => request<FileChangeInfo[]>("GET", `/api/sessions/${id}/changes`),
  acceptChange: (id: string, changeId: string) => request<FileChangeInfo>("POST", `/api/sessions/${id}/changes/${changeId}/accept`, {}),
  revertChange: (id: string, changeId: string, force = false) => request<FileChangeInfo>("POST", `/api/sessions/${id}/changes/${changeId}/revert`, { force }),
  acceptAll: (id: string) => request("POST", `/api/sessions/${id}/changes/accept-all`, {}),
  undo: (id: string) => request("POST", `/api/sessions/${id}/undo`, {}),
  redo: (id: string) => request("POST", `/api/sessions/${id}/redo`, {}),

  decide: (requestId: string, decision: PermissionDecision) =>
    request<{ resolved: boolean }>("POST", `/api/permissions/${requestId}`, { decision }),
  permissionRules: () => request<Array<{ tool: string; decision: "allow" | "deny" }>>("GET", "/api/permission-rules"),
  deletePermissionRule: (tool: string) => request("DELETE", `/api/permission-rules/${encodeURIComponent(tool)}`),

  config: () => request<PublicConfig>("GET", "/api/config"),
  updateConfig: (patch: Partial<Omit<PublicConfig, "hasApiKey" | "detectedContextLength" | "pricing">> & { apiKey?: string }) => request<PublicConfig>("PUT", "/api/config", patch),
  testConnection: () => request<ConnectionTest>("POST", "/api/config/test"),
  doctor: () => request<{ checks: DoctorCheck[] }>("GET", "/api/doctor"),

  terminalRun: (id: string, command: string) => request("POST", `/api/terminal/${id}/run`, { command }),
  terminalCancel: (id: string) => request("POST", `/api/terminal/${id}/cancel`, {}),
};

/** Subscribe to the runtime's event stream; reconnects automatically. Returns an unsubscribe function. */
export function subscribeEvents(onEvent: (e: ServerEvent) => void, onStatus?: (connected: boolean) => void): () => void {
  let es: EventSource | undefined;
  let closed = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const connect = () => {
    es = new EventSource(`${API_BASE}/api/events`);
    es.onopen = () => onStatus?.(true);
    es.onmessage = (m) => {
      try {
        onEvent(JSON.parse(m.data) as ServerEvent);
      } catch {
        /* ignore malformed frames */
      }
    };
    es.onerror = () => {
      onStatus?.(false);
      es?.close();
      if (!closed) retry = setTimeout(connect, 1500);
    };
  };
  connect();
  return () => {
    closed = true;
    if (retry) clearTimeout(retry);
    es?.close();
  };
}
