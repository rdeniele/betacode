// Types mirroring the runtime's HTTP API. The desktop app never imports server code.
// Event/permission/change types come from @betacode/shared (types only, erased at build time).
import type { AgentEvent, AgentMode, ChatMessage, FileChangeInfo, PermissionDecision, PermissionRequest, PlanItem, TokenUsage } from "../../../../packages/shared/src/types";

export type { AgentEvent, AgentMode, ChatMessage, FileChangeInfo, PermissionDecision, PermissionRequest, PlanItem, TokenUsage };

export interface DirEntry {
  name: string;
  path: string;
  type: "file" | "dir";
  size?: number;
  children?: DirEntry[];
  truncated?: boolean;
}

export interface ProjectInfo {
  name: string;
  root: string;
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  database: string[];
  orm: string[];
  auth: string[];
  testFrameworks: string[];
  commands: Array<{ name: string; command: string }>;
  entryPoints: string[];
  importantDirs: string[];
  isGitRepo: boolean;
}

export interface OpenProject {
  record: { id: string; path: string; name: string };
  info: ProjectInfo;
  summary: string;
  instructionFiles: string[];
  memory: string[];
  git: { isRepo: boolean; branch: string | null };
}

export interface SessionRecord {
  id: string;
  title: string;
  mode: AgentMode;
  provider: string;
  model: string;
  updatedAt: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
}

export interface ToolCallRow {
  callId: string;
  name: string;
  args: string;
  ok: boolean | null;
  durationMs: number | null;
  result: string | null;
}

export interface SessionDetail {
  session: SessionRecord;
  messages: ChatMessage[];
  toolCalls: ToolCallRow[];
  changes: FileChangeInfo[];
  running: boolean;
  plan: PlanItem[];
  pendingPermissions: PermissionRequest[];
  usage: TokenUsage;
}

export interface PublicConfig {
  provider: string;
  model: string;
  baseUrl: string;
  hasApiKey: boolean;
  /** Where the key in use comes from. */
  keySource?: "env" | "session" | "saved" | "none";
  canPersistKey?: boolean;
  teacher?: { enabled?: boolean; provider?: string; baseUrl: string; model: string };
  teacherKeySource?: "env" | "session" | "saved" | "none";
  teacherReady?: boolean;
  temperature: number;
  topP: number;
  topK: number;
  repetitionPenalty: number;
  contextLength: number;
  detectedContextLength?: number;
  maxIterations: number;
  maxRetries: number;
  autoCompact: boolean;
  permissions: Record<string, string>;
  pricing?: { inputPerMillion: number; outputPerMillion: number };
}

export interface ConnectionTest {
  ok: boolean;
  latencyMs: number;
  models: string[];
  modelAvailable: boolean;
  contextLength?: number;
  error?: string;
}

export interface GitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  staged: Array<{ path: string; index: string; workingTree: string }>;
  modified: Array<{ path: string; index: string; workingTree: string }>;
  untracked: string[];
  conflicted: Array<{ path: string }>;
  clean: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export type ServerEvent =
  | { scope: "session"; sessionId: string; event: AgentEvent }
  | { scope: "terminal"; id: string; kind: "output" | "exit"; chunk?: string; code?: number | null }
  | { scope: "setup"; kind: "progress"; tag: string; status: string; completed?: number; total?: number }
  | { scope: "setup"; kind: "done" | "cancelled"; tag: string }
  | { scope: "setup"; kind: "error"; tag: string; message: string }
  | { scope: "app"; kind: "project.opened" | "sessions.changed" | "config.changed" };

export type SlashResult = { kind: "text"; text: string } | { kind: "run"; started: boolean } | { kind: "ui"; action: string };

export interface DoctorCheck {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

export interface GpuInfo {
  name: string;
  vramGB: number;
  vendor: string;
}
export interface HardwareInfo {
  os: string;
  cpu: string;
  cores: number;
  ramGB: number;
  gpus: GpuInfo[];
  unified: boolean;
}
export interface CatalogModel {
  tag: string;
  label: string;
  sizeGB: number;
  thinking: boolean;
  quality: number;
  note: string;
}
export interface Fit {
  model: CatalogModel;
  contextLength: number;
  memoryNeededGB: number;
  placement: "gpu" | "split" | "cpu";
  gpuFraction: number;
  tokensPerSec: number;
  level: "great" | "good" | "slow" | "too-big";
  score: number;
  warnings: string[];
}
export interface OllamaStatus {
  installed: boolean;
  exe?: string;
  running: boolean;
  version?: string;
  models: Array<{ name: string; sizeGB: number }>;
  loadedContext?: number;
}
export interface SetupOverview {
  hardware: HardwareInfo;
  recommendation: { best?: Fit; options: Fit[] };
  ollama: OllamaStatus;
}
