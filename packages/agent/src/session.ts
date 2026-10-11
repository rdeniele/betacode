import type { AIProvider } from "@betacode/ai";
import type { BetaCodeConfig } from "@betacode/config";
import { ChangeTracker, FileService, Workspace, renderTree, type ChangeListener, type TrackedChange } from "@betacode/filesystem";
import { Git, formatStatus } from "@betacode/git";
import { createDefaultRegistry, type ToolRegistry } from "@betacode/tools";
import { detectProject, findInstructions, formatInstructions, formatMemory, formatProject, readMemory, type InstructionFile, type ProjectInfo } from "@betacode/project";
import { buildSystemPrompt } from "@betacode/prompts";
import type { AgentEvent, AgentMode, ChatMessage, Logger, PlanItem } from "@betacode/shared";
import { Agent, type AgentSettings, type RunOptions, type RunResult, type TeacherOptions } from "./agent";
import { PermissionManager, type PermissionPrompter, type RuleStore } from "./permissions";

export interface SessionOptions {
  root: string;
  config: BetaCodeConfig;
  provider: AIProvider;
  sessionId?: string;
  prompter?: PermissionPrompter;
  autoApprove?: "none" | "confirm";
  rules?: RuleStore;
  onEvent?: (e: AgentEvent) => void;
  onChange?: ChangeListener;
  logger?: Logger;
  history?: ChatMessage[];
  plan?: PlanItem[];
  initialChanges?: TrackedChange[];
  registry?: ToolRegistry;
  teacher?: TeacherOptions;
  mode?: AgentMode;
  /** Home directory for user-level BETACODE.md (defaults to none). */
  home?: string;
}

export function settingsFrom(c: BetaCodeConfig): AgentSettings {
  return {
    model: c.model,
    temperature: c.temperature,
    topP: c.topP,
    topK: c.topK,
    repetitionPenalty: c.repetitionPenalty,
    contextLength: c.contextLength,
    maxOutputTokens: c.maxOutputTokens,
    maxIterations: c.maxIterations,
    maxRetries: c.maxRetries,
    commandTimeoutMs: c.commandTimeoutMs,
    autoCompact: c.autoCompact,
  };
}

/** Everything needed to run the agent on one project: workspace, files, tracker, permissions, agent. */
export class AgentSession {
  readonly workspace: Workspace;
  readonly changes: ChangeTracker;
  readonly files: FileService;
  readonly permissions: PermissionManager;
  readonly project: ProjectInfo;
  readonly agent: Agent;
  instructionFiles: InstructionFile[];
  private gitSummary = "";

  private config: BetaCodeConfig;

  constructor(private readonly opts: SessionOptions) {
    this.config = opts.config;
    const emit = (e: AgentEvent) => opts.onEvent?.(e);
    this.workspace = new Workspace(opts.root);
    this.changes = new ChangeTracker(
      this.workspace,
      (c) => {
        opts.onChange?.(c);
        emit({ type: "file.changed", change: this.changes.toInfo(c) });
      },
      opts.initialChanges,
    );
    this.files = new FileService(this.workspace, this.changes, { requireReadBeforeEdit: true });
    this.permissions = new PermissionManager({
      prompter: opts.prompter,
      overrides: opts.config.permissions,
      rules: opts.rules,
      autoApprove: opts.autoApprove,
      emit,
    });
    this.project = detectProject(this.workspace.root);
    this.instructionFiles = findInstructions(this.workspace.root, { home: opts.home });
    const c = opts.config;
    this.agent = new Agent({
      provider: opts.provider,
      teacher: opts.teacher,
      registry: opts.registry ?? createDefaultRegistry(),
      workspace: this.workspace,
      files: this.files,
      permissions: this.permissions,
      settings: settingsFrom(c),
      systemPrompt: (mode, extra) => this.buildPrompt(mode, extra),
      onEvent: opts.onEvent,
      logger: opts.logger,
      project: this.project,
      history: opts.history,
      plan: opts.plan,
      mode: opts.mode,
      sessionId: opts.sessionId,
    });
  }

  private buildPrompt(mode: AgentMode, extra?: string): string {
    const changed = this.changes.list({ status: "pending" }).map((c) => c.path);
    const gitText = [this.gitSummary, changed.length ? `Files changed by BetaCode in this session: ${changed.join(", ")}` : ""].filter(Boolean).join("\n");
    return buildSystemPrompt({
      mode,
      cwd: this.workspace.root,
      platform: process.platform,
      date: new Date().toISOString().slice(0, 10),
      projectSummary: formatProject(this.project),
      projectTree: this.projectTree(),
      memory: formatMemory(readMemory(this.workspace.root)) || undefined,
      compact: this.config.contextLength <= 8192,
      instructions: formatInstructions(this.instructionFiles),
      gitSummary: gitText || undefined,
      extra,
    });
  }

  /** Depth-2 tree (capped) so the model starts with the layout instead of spending a step on it. */
  private projectTree(): string {
    try {
      const lines = renderTree(this.files.list(".", { depth: 2, maxEntries: 120 })).split("\n");
      const max = this.config.contextLength <= 16384 ? 50 : 100;
      return lines.length > max ? [...lines.slice(0, max), `… (${lines.length - max} more entries; use list_directory)`].join("\n") : lines.join("\n");
    } catch {
      return "";
    }
  }

  /** Refresh volatile context (git state, instruction files) just before a run. */
  async refresh(signal?: AbortSignal): Promise<void> {
    this.instructionFiles = findInstructions(this.workspace.root, { home: this.opts.home });
    try {
      const git = new Git(this.workspace.root, signal);
      if (await git.isRepo()) {
        const s = await git.status();
        this.gitSummary = formatStatus(s);
      } else {
        this.gitSummary = "Not a git repository.";
      }
    } catch {
      this.gitSummary = "";
    }
  }

  /** Apply new config/provider (takes effect on the next run). */
  reconfigure(config: BetaCodeConfig, provider: AIProvider, teacher?: TeacherOptions | null): void {
    this.config = config;
    this.agent.configure({ provider, settings: settingsFrom(config), ...(teacher !== undefined ? { teacher } : {}) });
    this.permissions.setOverrides(config.permissions);
  }

  async run(input: string, run: RunOptions = {}): Promise<RunResult> {
    await this.refresh(run.signal);
    return this.agent.run(input, run);
  }
}
