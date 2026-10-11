import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AIProvider, ChatRequest, ChatResponse, ModelInfo, StreamEvent } from "@betacode/ai";
import { ConfigSchema, type BetaCodeConfig } from "@betacode/config";
import type { AgentEvent, ToolCallRequest } from "@betacode/shared";
import { AgentSession, type PermissionPrompter, type SessionOptions } from "../src";

export type Step = ChatResponse | ((req: ChatRequest) => ChatResponse | Promise<ChatResponse>);

/** Test double for the model: replays a scripted list of responses and records every request. */
export class ScriptedProvider implements AIProvider {
  readonly id = "scripted";
  readonly name = "Scripted (tests)";
  readonly requests: ChatRequest[] = [];
  private i = 0;
  constructor(private readonly script: Step[]) {}
  supportsTools() {
    return true;
  }
  async getModels(): Promise<ModelInfo[]> {
    return [{ id: "scripted" }];
  }
  async chat(req: ChatRequest): Promise<ChatResponse> {
    this.requests.push(structuredClone({ ...req, signal: undefined }));
    const step = this.script[this.i++];
    if (!step) throw new Error("ScriptedProvider ran out of responses");
    return typeof step === "function" ? step(req) : step;
  }
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    const res = await this.chat(req);
    if (req.signal?.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    if (res.content) yield { type: "text", delta: res.content };
    yield { type: "done", response: res };
  }
}

let n = 0;
export const call = (name: string, args: unknown, id = `c${++n}`): ToolCallRequest => ({ id, name, arguments: typeof args === "string" ? args : JSON.stringify(args) });
export const say = (content: string): ChatResponse => ({ content, toolCalls: [], finishReason: "stop" });
export const use = (...calls: ToolCallRequest[]): ChatResponse => ({ content: "", toolCalls: calls, finishReason: "tool_calls" });

export const nodeCmd = (code: string) => `node -e "${code}"`;

export interface Harness {
  teacherProvider?: ScriptedProvider;
  dir: string;
  session: AgentSession;
  events: AgentEvent[];
  provider: ScriptedProvider;
  cleanup(): void;
}

export function makeConfig(over: Partial<BetaCodeConfig> = {}): BetaCodeConfig {
  return ConfigSchema.parse({ model: "scripted", ...over });
}

export function harness(script: Step[], opts: { teacherScript?: Step[]; prompter?: PermissionPrompter; config?: Partial<BetaCodeConfig>; setup?: (dir: string) => void; autoApprove?: SessionOptions["autoApprove"] } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "bc-agent-"));
  opts.setup?.(dir);
  const provider = new ScriptedProvider(script);
  const events: AgentEvent[] = [];
  const teacherProvider = opts.teacherScript ? new ScriptedProvider(opts.teacherScript) : undefined;
  const session = new AgentSession({
    teacher: teacherProvider ? { provider: teacherProvider, model: "teacher-model", label: "Teacher Pro", host: "api.teacher.test" } : undefined,
    root: dir,
    config: makeConfig(opts.config),
    provider,
    prompter: opts.prompter,
    autoApprove: opts.autoApprove,
    onEvent: (e) => events.push(e),
  });
  return { teacherProvider, dir, session, events, provider, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export const allow: PermissionPrompter = async () => "allow_once";
export const deny: PermissionPrompter = async () => "deny";
