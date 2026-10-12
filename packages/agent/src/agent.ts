import type { AIProvider, ChatResponse } from "@betacode/ai";
import { ProviderError } from "@betacode/ai";
import type { ChangeTracker, FileService, Workspace } from "@betacode/filesystem";
import { Git } from "@betacode/git";
import type { ProjectInfo } from "@betacode/project";
import {
  estimateTokens,
  isAbortError,
  nullLogger,
  type AgentEvent,
  type AgentMode,
  type AgentState,
  type ChatMessage,
  type Logger,
  type PlanItem,
  type StopReason,
  type TokenUsage,
  type ToolCallRequest,
} from "@betacode/shared";
import { FAILED_CHECK_REMINDER, QUALITY_REVIEW_REMINDER, STALLED_REMINDER, SUBAGENT_PROMPT, verificationReminder } from "@betacode/prompts";
import { looksLikeTestCommand } from "@betacode/terminal";
import type { AgentTool, ToolContext, ToolRegistry, ToolResult } from "@betacode/tools";
import { claimCorrection, commandForTool, unverifiedCommandClaims } from "./claims";
import { ContextManager, SUMMARY_MARKER } from "./context";
import type { PermissionManager } from "./permissions";
import { ProgressMonitor } from "./progress";

export interface AgentSettings {
  model: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  repetitionPenalty?: number;
  contextLength: number;
  maxOutputTokens?: number;
  maxIterations: number;
  /** Max consecutive failing test/build/lint commands before the agent must stop and report. */
  maxRetries: number;
  commandTimeoutMs: number;
  autoCompact: boolean;
}

/** A stronger (usually hosted) model that can take over when the main model is stuck. */
export interface TeacherOptions {
  provider: AIProvider;
  model: string;
  /** Shown to the user, e.g. "gemini-2.0-flash". */
  label: string;
  /** Where the conversation would be sent, shown in the consent prompt. */
  host: string;
}

export interface AgentOptions {
  /** Optional stronger model used (with the user's consent) when the main model gets stuck. */
  teacher?: TeacherOptions;
  provider: AIProvider;
  registry: ToolRegistry;
  workspace: Workspace;
  files: FileService;
  permissions: PermissionManager;
  settings: AgentSettings;
  /** Builds the system prompt; called at the start of every run so instructions are always fresh. */
  systemPrompt: (mode: AgentMode, extra?: string) => string;
  onEvent?: (e: AgentEvent) => void;
  logger?: Logger;
  project?: ProjectInfo;
  /** Resume from earlier conversation (already compacted if applicable). */
  history?: ChatMessage[];
  plan?: PlanItem[];
  mode?: AgentMode;
  /** 0 = main agent, ≥1 = sub-agent (cannot delegate). */
  depth?: number;
  sessionId?: string;
  /** Extra text appended to the system prompt (sub-agents). */
  promptExtra?: string;
}

export interface RunResult {
  reason: StopReason;
  message?: string;
  steps: number;
  usage: TokenUsage;
  /** Last assistant text. */
  finalText: string;
}

export interface RunOptions {
  signal?: AbortSignal;
  mode?: AgentMode;
}

const READ_ONLY_MODES: AgentMode[] = ["ask", "plan", "review", "explore"];

/** Tools a mode may use. Read-only modes never get tools that can modify anything. */
export function toolsForMode(registry: ToolRegistry, mode: AgentMode): ToolRegistry {
  if (READ_ONLY_MODES.includes(mode)) return registry.subset((t) => t.readOnly);
  return registry;
}

const MAX_SUBAGENT_STEPS = 12;

/** Remove reasoning blocks some Qwen3 runtimes put inline; they only waste context on later turns. */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, "").replace(/<think>[\s\S]*$/, "");
}

const MAX_IDENTICAL_FAILURES = 4;

function stateForTool(tool: AgentTool, args: unknown): AgentState {
  switch (tool.kind) {
    case "read":
      return "READING";
    case "search":
      return "SEARCHING";
    case "edit":
      return "EDITING";
    case "run": {
      const cmd = (args as { command?: string })?.command ?? "";
      return looksLikeTestCommand(cmd) ? "TESTING" : "RUNNING";
    }
    case "diagnostics":
      return "TESTING";
    case "plan":
      return "PLANNING";
    case "git":
      return tool.readOnly ? "READING" : "RUNNING";
    default:
      return "READING";
  }
}

export class Agent {
  history: ChatMessage[];
  plan: PlanItem[];
  readonly context = new ContextManager();
  private usageTotal: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private lastPromptTokens = 0;
  private steps = 0;
  private hasSummaryAtHead: boolean;
  /** Messages (from the persisted log) already folded into summaries. */
  foldedTotal = 0;
  private readonly logger: Logger;
  private readonly depth: number;
  state: AgentState = "IDLE";
  /** Set while a teacher has taken over the current run. */
  private active?: { provider: AIProvider; model: string };
  private escalated = false;

  constructor(private readonly opts: AgentOptions) {
    this.history = [...(opts.history ?? [])];
    this.plan = [...(opts.plan ?? [])];
    this.logger = opts.logger ?? nullLogger;
    this.depth = opts.depth ?? 0;
    this.hasSummaryAtHead = this.history[0]?.content.startsWith(SUMMARY_MARKER) ?? false;
  }

  get mode(): AgentMode {
    return this.opts.mode ?? "code";
  }

  setMode(m: AgentMode): void {
    this.opts.mode = m;
  }

  get totalUsage(): TokenUsage {
    return { ...this.usageTotal };
  }

  private emit(e: AgentEvent): void {
    this.opts.onEvent?.(e);
  }

  private setState(state: AgentState, detail?: string): void {
    this.state = state;
    this.emit({ type: "agent.state", state, detail });
  }

  private push(message: ChatMessage): void {
    this.history.push(message);
    this.emit({ type: "agent.message", message });
  }

  /** Run the agent on a user request until it finishes, is cancelled, denied, or hits a limit. */
  async run(input: string, run: RunOptions = {}): Promise<RunResult> {
    const signal = run.signal ?? new AbortController().signal;
    const mode = run.mode ?? this.mode;
    this.opts.mode = mode;
    const s = this.opts.settings;
    const registry = toolsForMode(this.opts.registry, mode);
    const specs = registry.specs();
    const started = Date.now();
    this.steps = 0;
    this.active = undefined;
    this.escalated = false;

    this.opts.files.changes.nextTurn();
    this.emit({ type: "agent.started", sessionId: this.opts.sessionId ?? "", mode });
    this.logger.log("info", "agent.started", { mode, sessionId: this.opts.sessionId, input: input.slice(0, 500) });
    this.push({ role: "user", content: input });

    let finalText = "";
    let lastFailed = false;
    let testFailures = 0;
    let toolsDisabled = false;
    let limitNoticeSent = false;
    let editedSinceCheck = false;
    const uiTask = /\b(landing\s*page|website|web\s*page|frontend|front-end|ui|ux|dashboard|layout|responsive|redesign)\b/i.test(input);
    let needsQualityReview = false;
    let qualityReviews = 0;
    let verifyNudged = false;
    let failedCheckNudged = false;
    let latestCheckFailed = false;
    let stalledNudged = false;
    const progress = new ProgressMonitor();
    let truncationWarned = false;
    let claimNudged = false;
    const executedCommands: string[] = [];
    let nudges = 0;
    let invalidInARow = 0;
    const failureCounts = new Map<string, number>();

    const finish = (reason: StopReason, message?: string): RunResult => {
      const state: AgentState = reason === "completed" ? "COMPLETED" : reason === "cancelled" ? "CANCELLED" : reason === "permission_denied" ? "COMPLETED" : "FAILED";
      this.setState(state, message);
      this.emit({ type: "agent.completed", reason, message });
      this.logger.log(reason === "error" ? "error" : "info", "agent.completed", { reason, message, steps: this.steps, durationMs: Date.now() - started });
      return { reason, message, steps: this.steps, usage: this.totalUsage, finalText };
    };

    for (;;) {
      if (signal.aborted) return finish("cancelled");
      if (this.steps >= s.maxIterations) {
        return finish("max_iterations", `Stopped after ${s.maxIterations} steps. Send another message to continue.`);
      }
      this.steps++;

      const system = this.opts.systemPrompt(mode, this.opts.promptExtra);
      const fixedTokens = estimateTokens(system) + estimateTokens(JSON.stringify(specs));

      if (s.autoCompact) {
        try {
          await this.compactIfNeeded(system, fixedTokens, signal);
        } catch (e) {
          if (isAbortError(e) || signal.aborted) return finish("cancelled");
        }
      }

      this.setState(lastFailed ? "RECOVERING" : "THINKING");
      let response: ChatResponse;
      const sentMessages: ChatMessage[] = [{ role: "system", content: system }, ...this.history];
      const estimatedBefore = this.context.estimate(this.history, fixedTokens);
      try {
        response = await this.callModel(sentMessages, toolsDisabled ? undefined : specs, signal);
      } catch (e) {
        if (isAbortError(e) || signal.aborted) return finish("cancelled");
        const message = (e as Error).message;
        this.emit({ type: "model.error", message });
        this.logger.log("error", "model.error", { message });
        return finish("error", message);
      }

      if (response.usage) {
        this.usageTotal.inputTokens += response.usage.inputTokens;
        this.usageTotal.outputTokens += response.usage.outputTokens;
        this.lastPromptTokens = response.usage.inputTokens;
        // A server that reads far fewer tokens than we sent is silently cutting the prompt (for example Ollama's default 4096 context).
        const truncated = estimatedBefore > 2500 && response.usage.inputTokens < estimatedBefore * 0.55 && response.usage.inputTokens <= 8192;
        if (truncated && !truncationWarned) {
          truncationWarned = true;
          this.emit({
            type: "agent.notice",
            level: "warn",
            message: `The model server read only ~${response.usage.inputTokens} of ~${estimatedBefore} prompt tokens, so it is cutting off part of the prompt and the model will behave poorly. Increase the server's context window (Ollama: set OLLAMA_CONTEXT_LENGTH=16384 and restart it) and keep BetaCode's context setting at or below it.`,
          });
        }
        if (!truncated) this.context.calibrate(estimatedBefore, response.usage.inputTokens);
      } else {
        this.lastPromptTokens = estimatedBefore;
        this.usageTotal.inputTokens += estimatedBefore;
        this.usageTotal.outputTokens += estimateTokens(response.content);
      }
      this.emit({ type: "usage", usage: this.totalUsage, contextTokens: this.lastPromptTokens, contextLimit: s.contextLength, steps: this.steps });

      const calls = toolsDisabled ? [] : response.toolCalls;
      const content = stripThinking(response.content);
      this.push({ role: "assistant", content, toolCalls: calls.length ? calls : undefined });
      if (content.trim()) finalText = content;

      if (calls.length === 0) {
        if (!content.trim() && nudges < 2) {
          nudges++;
          this.push({ role: "user", content: "Your last reply was empty. Continue the task with a tool call, or give your final answer." });
          continue;
        }
        if (response.finishReason === "length" && nudges < 2) {
          nudges++;
          this.push({ role: "user", content: "Your reply was cut off by the output limit. Continue from where you stopped, in smaller steps." });
          continue;
        }
        // Do not let the agent declare victory on code it never ran.
        if (editedSinceCheck && !verifyNudged && !toolsDisabled && (mode === "code" || mode === "debug")) {
          const cmds = (this.opts.project?.commands ?? []).filter((c) => ["test", "typecheck", "lint", "build"].includes(c.name)).map((c) => c.command);
          if (cmds.length) {
            verifyNudged = true;
            this.push({ role: "user", content: verificationReminder(cmds) });
            continue;
          }
        }
        if (latestCheckFailed && !failedCheckNudged && !toolsDisabled && (mode === "code" || mode === "debug")) {
          failedCheckNudged = true;
          this.push({ role: "user", content: FAILED_CHECK_REMINDER });
          continue;
        }
        // Catch reports that name commands nothing actually ran.
        if (!claimNudged && !toolsDisabled) {
          const bad = unverifiedCommandClaims(content, executedCommands);
          if (bad.length) {
            claimNudged = true;
            this.push({ role: "user", content: claimCorrection(bad) });
            continue;
          }
        }
        if (uiTask && needsQualityReview && qualityReviews < 2 && !toolsDisabled && (mode === "code" || mode === "debug")) {
          qualityReviews++;
          needsQualityReview = false;
          this.emit({ type: "agent.notice", level: "info", message: "Reviewing the implementation and refining any concrete issues before finishing." });
          this.push({ role: "user", content: QUALITY_REVIEW_REMINDER });
          continue;
        }
        return finish("completed");
      }

      // Independent read-only calls (reads, searches, listings) run concurrently.
      const parallel = calls.length > 1 && calls.every((c) => {
        const t = registry.get(c.name);
        return !!t && t.readOnly && t.kind !== "agent" && t.kind !== "plan";
      });
      const preRun = parallel ? await Promise.all(calls.map((c) => this.executeCall(c, registry, signal))) : undefined;

      let denied = false;
      let fatal: string | undefined;
      let stalled = false;
      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        if (denied || signal.aborted || fatal) {
          this.push({ role: "tool", toolCallId: call.id, name: call.name, content: signal.aborted ? "Cancelled by the user before this tool ran." : "Skipped because an earlier action in this turn was refused or failed." });
          continue;
        }
        const outcome = preRun ? preRun[i]! : await this.executeCall(call, registry, signal);
        this.push({ role: "tool", toolCallId: call.id, name: call.name, content: outcome.content });
        if (outcome.invalid) invalidInARow++;
        else invalidInARow = 0;
        if (invalidInARow >= 5) fatal = "The model repeatedly sent invalid tool calls.";
        lastFailed = !outcome.ok;
        const tool = registry.get(call.name);
        if (outcome.ok && tool?.readOnly && tool.kind !== "plan" && tool.kind !== "agent" && tool.kind !== "diagnostics") {
          stalled = progress.observe(call.name, call.arguments, outcome.content) || stalled;
        } else if (tool && !tool.readOnly && outcome.ok) {
          progress.reset();
          stalled = false;
        }
        if (outcome.denied) denied = true;
        if (!outcome.ok && !outcome.denied) {
          const fp = `${call.name}:${call.arguments}`;
          const n = (failureCounts.get(fp) ?? 0) + 1;
          failureCounts.set(fp, n);
          if (n >= MAX_IDENTICAL_FAILURES) fatal = `The same ${call.name} call failed ${n} times with identical arguments; giving up to avoid an endless loop.`;
        }
        if (!outcome.invalid && !outcome.denied) {
          let parsedArgs: unknown;
          try {
            parsedArgs = JSON.parse(call.arguments || "{}");
          } catch {
            parsedArgs = undefined;
          }
          const ran = commandForTool(call.name, parsedArgs);
          if (ran) executedCommands.push(ran);
        }
        if (outcome.edited) {
          editedSinceCheck = true;
          needsQualityReview = true;
          // A quality-review fix needs a fresh check too.
          if (qualityReviews > 0) verifyNudged = false;
        }
        if (outcome.isCheck) {
          latestCheckFailed = !outcome.ok;
          editedSinceCheck = false;
          testFailures = outcome.ok ? 0 : testFailures + 1;
          if (testFailures > s.maxRetries) {
            toolsDisabled = true;
          }
        }
      }
      if (signal.aborted) return finish("cancelled");
      if (denied) return finish("permission_denied", "An action was denied. Tell me how you'd like to proceed.");
      if (stalled && !fatal) {
        progress.reset();
        if (stalledNudged) fatal = "The model repeated unchanged reads or searches after a recovery reminder. Stopped to avoid an endless loop.";
        else {
          stalledNudged = true;
          this.emit({ type: "agent.notice", level: "warn", message: "Repeated unchanged reads or searches detected; asking the current model to change approach." });
          this.push({ role: "user", content: STALLED_REMINDER });
        }
      }
      const stuck = fatal ?? (toolsDisabled ? `the project's checks are still failing after ${s.maxRetries} attempts` : undefined);
      if (stuck && (await this.tryEscalate(stuck, signal))) {
        failureCounts.clear();
        invalidInARow = 0;
        testFailures = 0;
        toolsDisabled = false;
        limitNoticeSent = false;
        lastFailed = false;
        progress.reset();
        continue;
      }
      if (signal.aborted) return finish("cancelled");
      if (fatal) return finish("error", fatal);
      if (toolsDisabled && !limitNoticeSent) {
        limitNoticeSent = true;
        this.push({
          role: "user",
          content: `Automatic retry limit reached: ${s.maxRetries} consecutive failing check runs. Do not run more commands. Write a final report: what you changed, what still fails (with the exact errors), and your best diagnosis.`,
        });
      }
    }
  }

  private async callModel(messages: ChatMessage[], tools: ReturnType<ToolRegistry["specs"]> | undefined, signal: AbortSignal): Promise<ChatResponse> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.callModelOnce(messages, tools, signal);
      } catch (error) {
        if (signal.aborted || isAbortError(error) || !(error instanceof ProviderError) || !error.retryable || attempt >= 2) throw error;
        // Tools execute only after a complete response. Discarding this partial
        // model turn preserves completed work and cannot repeat an edit.
        this.emit({ type: "agent.notice", level: "warn", message: `Model connection interrupted. Retrying the current response (${attempt + 1}/2); completed edits are saved.` });
      }
    }
  }

  private async callModelOnce(messages: ChatMessage[], tools: ReturnType<ToolRegistry["specs"]> | undefined, signal: AbortSignal): Promise<ChatResponse> {
    const s = this.opts.settings;
    const t0 = Date.now();
    let final: ChatResponse | undefined;
    let text = "";
    const teacher = this.active;
    for await (const ev of (teacher?.provider ?? this.opts.provider).stream({
      model: teacher?.model ?? s.model,
      messages,
      tools,
      // The sampling values are tuned for the local model; a hosted teacher uses its own defaults, slightly cooler.
      temperature: teacher ? 0.3 : s.temperature,
      topP: teacher ? undefined : s.topP,
      topK: teacher ? undefined : s.topK,
      repetitionPenalty: teacher ? undefined : s.repetitionPenalty,
      maxTokens: s.maxOutputTokens,
      signal,
    })) {
      if (ev.type === "text") {
        text += ev.delta;
        this.emit({ type: "agent.text", delta: ev.delta });
      } else if (ev.type === "done") final = ev.response;
    }
    if (signal.aborted) throw Object.assign(new Error("Aborted"), { name: "AbortError" });
    const response = final ?? { content: text, toolCalls: [], finishReason: "unknown" as const };
    this.logger.log("info", "model.response", {
      durationMs: Date.now() - t0,
      finishReason: response.finishReason,
      toolCalls: response.toolCalls.map((c) => c.name),
      usage: response.usage,
      messages: messages.length,
    });
    return response;
  }

  private makeContext(callId: string, signal: AbortSignal): ToolContext {
    const o = this.opts;
    return {
      workspace: o.workspace,
      files: o.files,
      signal,
      callId,
      emit: (e) => this.emit(e),
      git: () => new Git(o.workspace.root, signal),
      project: o.project,
      commandTimeoutMs: o.settings.commandTimeoutMs,
      plan: {
        get: () => this.plan,
        set: (p) => {
          this.plan = p;
        },
      },
      delegate: this.depth === 0 ? (task, sig) => this.runSubAgent(task, callId, sig) : undefined,
    };
  }

  private async executeCall(
    call: ToolCallRequest,
    registry: ToolRegistry,
    signal: AbortSignal,
  ): Promise<{ ok: boolean; content: string; denied?: boolean; invalid?: boolean; isCheck?: boolean; edited?: boolean }> {
    const parsed = registry.parseArguments(call.name, call.arguments);
    if (!parsed.ok) {
      this.emit({ type: "tool.started", callId: call.id, name: call.name, args: call.arguments });
      this.emit({ type: "tool.completed", callId: call.id, name: call.name, ok: false, content: parsed.error, durationMs: 0 });
      this.logger.log("warn", "tool.failed", { name: call.name, error: parsed.error });
      return { ok: false, content: `Error: ${parsed.error}`, invalid: true };
    }
    const tool = registry.get(call.name)!;
    const ctx = this.makeContext(call.id, signal);

    let assessment;
    try {
      assessment = await tool.assess(parsed.args, ctx);
    } catch {
      assessment = { level: "confirm" as const, summary: `${call.name} ${call.arguments.slice(0, 200)}` };
    }

    this.emit({ type: "tool.started", callId: call.id, name: call.name, args: parsed.args });

    {
      const before = this.state;
      const needsPrompt = assessment.level !== "safe";
      if (needsPrompt) this.setState("WAITING_FOR_PERMISSION", assessment.summary);
      const outcome = await this.opts.permissions.check(tool, assessment, signal);
      if (!outcome.allowed) {
        const content = outcome.message ?? "The action was not permitted.";
        this.emit({ type: "tool.completed", callId: call.id, name: call.name, ok: false, content, durationMs: 0 });
        this.logger.log("info", "permission.denied", { tool: call.name, summary: assessment.summary });
        return { ok: false, content: `Denied: ${content}`, denied: true };
      }
      if (needsPrompt) this.setState(before);
    }

    this.setState(stateForTool(tool, parsed.args), assessment.summary);
    const t0 = Date.now();
    let result: ToolResult;
    try {
      result = await tool.execute(parsed.args, ctx);
    } catch (e) {
      if (isAbortError(e) || signal.aborted) result = { ok: false, content: "Cancelled by the user." };
      else result = { ok: false, content: `Error: tool ${call.name} crashed: ${(e as Error).message}` };
    }
    const durationMs = Date.now() - t0;
    this.emit({ type: "tool.completed", callId: call.id, name: call.name, ok: result.ok, content: result.content, durationMs });
    this.logger.log(result.ok ? "info" : "warn", result.ok ? "tool.completed" : "tool.failed", { name: call.name, durationMs, summary: assessment.summary });
    const isCheck = tool.kind === "run" ? looksLikeTestCommand((parsed.args as { command: string }).command) : tool.kind === "diagnostics";
    return { ok: result.ok, content: result.content, isCheck, edited: tool.kind === "edit" && result.ok };
  }

  private async runSubAgent(task: string, parentCallId: string, signal: AbortSignal): Promise<string> {
    const o = this.opts;
    const readOnly = o.registry.subset((t) => t.readOnly && t.kind !== "agent" && t.kind !== "plan");
    const sub = new Agent({
      ...o,
      registry: readOnly,
      depth: this.depth + 1,
      history: [],
      plan: [],
      mode: "explore",
      promptExtra: o.promptExtra,
      settings: { ...o.settings, maxIterations: MAX_SUBAGENT_STEPS, autoCompact: true },
      onEvent: (e) => {
        if (e.type === "tool.started") this.emit({ type: "tool.output", callId: parentCallId, chunk: `[sub-agent] ${e.name}\n` });
        else if (e.type === "permission.requested" || e.type === "permission.resolved") this.emit(e);
      },
      systemPrompt: (mode) => o.systemPrompt(mode, SUBAGENT_PROMPT),
    });
    const r = await sub.run(task, { signal, mode: "explore" });
    this.usageTotal.inputTokens += r.usage.inputTokens;
    this.usageTotal.outputTokens += r.usage.outputTokens;
    if (r.reason !== "completed") return `Sub-agent stopped early (${r.reason}${r.message ? `: ${r.message}` : ""}). Partial findings: ${r.finalText || "none"}`;
    return r.finalText;
  }

  private async compactIfNeeded(system: string, fixedTokens: number, signal: AbortSignal): Promise<void> {
    const s = this.opts.settings;
    const budget = { contextLimit: s.contextLength, outputReserve: s.maxOutputTokens ?? Math.min(4096, Math.floor(s.contextLength * 0.1)), fixedTokens };
    void system;
    if (!this.context.needsCompaction(this.history, budget)) return;
    await this.compact(signal, budget);
  }

  /** Summarise older conversation now (also used by /compact). Returns the summary, or undefined if nothing to do. */
  async compact(signal?: AbortSignal, budgetOverride?: { contextLimit: number; outputReserve: number; fixedTokens: number }): Promise<string | undefined> {
    const s = this.opts.settings;
    const budget = budgetOverride ?? { contextLimit: s.contextLength, outputReserve: 0, fixedTokens: 0 };
    // For a manual /compact, force summarisation regardless of size.
    const forced = !budgetOverride;
    const facts = {
      modifiedFiles: this.opts.files.changes.list().filter((c) => c.status !== "reverted").map((c) => c.path),
      plan: this.plan,
    };
    const effective = forced ? { ...budget, contextLimit: 1 } : budget;
    const r = await this.context.compact(this.history, effective, facts, this.opts.provider, s.model, signal, this.hasSummaryAtHead);
    if (!r) return undefined;
    this.history = r.history;
    if (r.summary) {
      this.hasSummaryAtHead = true;
      this.foldedTotal += r.folded;
      this.emit({ type: "session.compacted", summary: r.summary });
      this.logger.log("info", "session.compacted", { folded: r.folded, usedModel: r.usedModel });
    }
    return r.summary || undefined;
  }

  /**
   * Ask the user whether a stronger model may take over because the main model is stuck. Nothing is sent anywhere
   * unless the user agrees. Returns true if the teacher is now active.
   */
  private async tryEscalate(reason: string, signal: AbortSignal): Promise<boolean> {
    const t = this.opts.teacher;
    if (!t || this.escalated || this.depth > 0 || signal.aborted) return false;
    const pseudoTool = { name: "escalate_to_teacher", description: "", kind: "agent", readOnly: false } as unknown as AgentTool;
    this.setState("WAITING_FOR_PERMISSION", `ask ${t.label} for help`);
    const outcome = await this.opts.permissions.check(
      pseudoTool,
      {
        level: "confirm",
        summary: `Ask ${t.label} (${t.host}) to take over`,
        detail: `Why: ${reason}\n\nThe whole conversation so far, including the contents of files the agent has read, will be sent to ${t.host}.`,
        grantKey: "escalate_to_teacher",
      },
      signal,
    );
    if (!outcome.allowed) return false;
    this.escalated = true;
    this.active = { provider: t.provider, model: t.model };
    this.emit({ type: "agent.notice", level: "info", message: `Escalated to ${t.label} (${t.host}): ${reason}` });
    this.logger.log("info", "agent.escalated", { teacher: t.label, host: t.host, reason });
    this.push({
      role: "user",
      content: `A stronger model (${t.label}) is taking over because the previous model got stuck: ${reason}. Review what has happened so far, work out why it keeps failing, and complete the user's original request. Keep using the tools and verify with real commands.`,
    });
    return true;
  }

  /** Swap provider/settings between runs (e.g. after the user edits model settings). */
  configure(patch: { provider?: AIProvider; settings?: AgentSettings; teacher?: TeacherOptions | null }): void {
    if (patch.teacher !== undefined) this.opts.teacher = patch.teacher ?? undefined;
    if (patch.provider) this.opts.provider = patch.provider;
    if (patch.settings) this.opts.settings = patch.settings;
  }

  clear(): void {
    this.history = [];
    this.plan = [];
    this.foldedTotal = 0;
    this.hasSummaryAtHead = false;
  }
}
