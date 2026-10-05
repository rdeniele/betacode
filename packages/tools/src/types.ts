import type { AgentEvent, PermissionLevel, PlanItem } from "@betacode/shared";
import type { z } from "@betacode/shared";
import type { FileService, Workspace } from "@betacode/filesystem";
import type { Git } from "@betacode/git";
import type { ProjectInfo } from "@betacode/project";

export interface ToolResult {
  /** False means the action failed or the outcome was negative (e.g. non-zero exit code). */
  ok: boolean;
  /** Text returned to the model. */
  content: string;
  data?: unknown;
}

export interface PermissionAssessment {
  level: PermissionLevel;
  /** Short human-readable description shown in the approval dialog. */
  summary: string;
  /** Extra detail, e.g. a diff preview. */
  detail?: string;
  reason?: string;
  /** Stable key for "allow for session" grants. Defaults to the tool name. */
  grantKey?: string;
}

export type ToolKind = "read" | "search" | "edit" | "run" | "plan" | "git" | "agent" | "diagnostics";

export interface PlanStore {
  get(): PlanItem[];
  set(plan: PlanItem[]): void;
}

export interface ToolContext {
  workspace: Workspace;
  files: FileService;
  signal: AbortSignal;
  callId: string;
  emit(event: AgentEvent): void;
  git(): Git;
  project?: ProjectInfo;
  commandTimeoutMs: number;
  plan: PlanStore;
  /** Present for the main agent only; runs a read-only sub-agent and returns its summary. */
  delegate?: (task: string, signal: AbortSignal) => Promise<string>;
}

export interface AgentTool<A = any> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  kind: ToolKind;
  /** True when the tool can never modify the project (used for Ask/Plan/Review/Explore modes and sub-agents). */
  readOnly: boolean;
  /** Decide how risky this specific invocation is. Must not throw and must not change anything. */
  assess(args: A, ctx: ToolContext): PermissionAssessment | Promise<PermissionAssessment>;
  execute(args: A, ctx: ToolContext): Promise<ToolResult>;
}
