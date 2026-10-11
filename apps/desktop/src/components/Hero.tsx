import { Compass, FolderOpen, GitBranch } from "lucide-react";
import type { AgentMode } from "../lib/types";
import { useApp } from "../stores/app";
import { Composer } from "./Composer";

const TIPS = [
  "Type / for commands. /init writes a BETACODE.md that teaches BetaCode your project.",
  "Ctrl+K opens the command palette; Ctrl+P finds a file by name.",
  "Plan mode shows what BetaCode intends to do before it changes anything.",
  "Every edit shows up as a diff you can accept, reject or undo (Ctrl+Z).",
  "Chat mode answers questions about your code without touching it.",
];

const STARTERS: Array<{ label: string; text: string; mode: AgentMode }> = [
  { label: "Explain this project", text: "Give me a short tour of this project: what it does, how it is organised, and how to run and test it.", mode: "ask" },
  { label: "Find & fix a bug", text: "Run the tests for this project. If something fails, find the cause and fix it.", mode: "code" },
  { label: "Review my changes", text: "Review my current uncommitted changes and list any real problems.", mode: "review" },
  { label: "Plan a feature", text: "I want to add a new feature. Ask me what it should do, then propose a step-by-step plan.", mode: "plan" },
];

/** Welcome screen for an empty session: wordmark, tagline, status, composer and quick starts. */
export function Hero({ running, mode, onMode, onSend, onStop }: { running: boolean; mode: AgentMode; onMode: (m: AgentMode) => void; onSend: (t: string) => void; onStop: () => void }) {
  const { project, modelStatus, config, activeId } = useApp();
  const set = useApp((s) => s.set);
  const tip = TIPS[new Date().getDate() % TIPS.length]!;
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-8">
      <div className="w-full max-w-2xl">
        <div className="flex flex-col items-center text-center">
          <Compass size={30} className="mb-2 text-accent" strokeWidth={1.6} aria-hidden />
          <h1 className="text-[30px] font-bold tracking-tight">
            Beta<span className="text-accent">Code</span>
          </h1>
          <p className="mt-1 text-[13px] text-muted">AI coding agent for your projects.</p>
          <p className="mt-5 max-w-md text-[11.5px] leading-relaxed text-faint">Tip: {tip}</p>
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2 text-[11.5px]">
            {project && (
              <span className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-muted">
                <FolderOpen size={12} /> {project.info.name}
                {project.git.branch && (
                  <span className="flex items-center gap-1 text-faint">
                    <GitBranch size={11} />
                    {project.git.branch}
                  </span>
                )}
              </span>
            )}
            {modelStatus === "unreachable" ? (
              <button className="flex items-center gap-1.5 rounded-full border border-warn/50 bg-warn/10 px-2.5 py-1 text-warn hover:bg-warn/20" onClick={() => set({ dialog: "settings", settingsTab: "local" })}>
                <span className="h-1.5 w-1.5 rounded-full bg-warn" aria-hidden /> No model connected — set up local AI
              </button>
            ) : (
              <button className="flex items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-muted hover:bg-hover" onClick={() => set({ dialog: "settings", settingsTab: "models" })}>
                <span className={modelStatus === "connected" ? "h-1.5 w-1.5 rounded-full bg-ok" : "h-1.5 w-1.5 rounded-full bg-faint"} aria-hidden /> {config?.model ?? "model"}
              </button>
            )}
          </div>
        </div>
        <div className="mt-7">
          <Composer hero running={running} disabled={!project || !activeId} mode={mode} onMode={onMode} onSend={onSend} onStop={onStop} />
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-2" aria-label="Quick starts">
          {STARTERS.map((s) => (
            <button
              key={s.label}
              className="rounded-full border border-line px-3 py-1 text-[12px] text-muted transition-colors hover:border-accent/50 hover:bg-hover hover:text-text"
              onClick={() => {
                onMode(s.mode);
                onSend(s.text);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
