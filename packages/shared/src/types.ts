/** Core types shared by every BetaCode package. No runtime dependencies. */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCallRequest {
  id: string;
  name: string;
  /** Raw JSON string exactly as produced by the model (may be malformed). */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Present on assistant messages that request tool calls. */
  toolCalls?: ToolCallRequest[];
  /** Present on tool messages: the call being answered. */
  toolCallId?: string;
  name?: string;
}

export interface JsonSchemaObject {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** Provider-neutral tool description sent to the model. */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchemaObject;
}

export type PermissionLevel = "safe" | "confirm" | "dangerous";

export type AgentState =
  | "IDLE"
  | "THINKING"
  | "PLANNING"
  | "READING"
  | "SEARCHING"
  | "EDITING"
  | "RUNNING"
  | "TESTING"
  | "WAITING_FOR_PERMISSION"
  | "RECOVERING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type AgentMode = "ask" | "code" | "plan" | "review" | "debug" | "explore";

export type StopReason =
  | "completed"
  | "cancelled"
  | "permission_denied"
  | "max_iterations"
  | "error";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type PlanStatus = "pending" | "in_progress" | "done";
export interface PlanItem {
  text: string;
  status: PlanStatus;
}

export type PermissionDecision =
  | "allow_once"
  | "allow_session"
  | "always_allow"
  | "always_deny"
  | "deny";

export interface PermissionRequest {
  id: string;
  tool: string;
  /** Human readable action, e.g. the command line or the file path. */
  summary: string;
  /** Optional detail such as a unified diff preview. */
  detail?: string;
  reason?: string;
  riskLevel: PermissionLevel;
  /** Key used for session grants. */
  grantKey: string;
}

export interface FileChangeInfo {
  id: string;
  path: string;
  kind: "added" | "modified" | "deleted";
  status: "pending" | "accepted" | "reverted";
  turn: number;
  additions: number;
  deletions: number;
  diff: string;
}

/** Events emitted while an agent runs. The UI, CLI and logs all consume these. */
export type AgentEvent =
  | { type: "agent.started"; sessionId: string; mode: AgentMode }
  | { type: "agent.state"; state: AgentState; detail?: string }
  | { type: "agent.text"; delta: string }
  | { type: "agent.message"; message: ChatMessage }
  | { type: "tool.started"; callId: string; name: string; args: unknown }
  | { type: "tool.output"; callId: string; chunk: string }
  | { type: "tool.completed"; callId: string; name: string; ok: boolean; content: string; durationMs: number }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.resolved"; requestId: string; decision: PermissionDecision }
  | { type: "file.changed"; change: FileChangeInfo }
  | { type: "plan.updated"; plan: PlanItem[] }
  | { type: "usage"; usage: TokenUsage; contextTokens: number; contextLimit: number; steps: number }
  | { type: "session.compacted"; summary: string }
  | { type: "model.error"; message: string }
  | { type: "agent.completed"; reason: StopReason; message?: string };

export type EventListener = (event: AgentEvent) => void;

export class BetaCodeError extends Error {
  constructor(message: string, readonly code: string = "ERROR") {
    super(message);
    this.name = "BetaCodeError";
  }
}

export function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || (err as { code?: string }).code === "ABORT_ERR");
}
