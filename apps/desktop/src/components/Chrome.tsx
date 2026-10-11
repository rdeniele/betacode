import clsx from "clsx";
import { Command, FolderOpen, GitBranch, Settings, SquareTerminal, X } from "lucide-react";
import { useEffect } from "react";
import { useApp } from "../stores/app";
import { estimateCost } from "./ContextPanel";
import { IconButton, Kbd, formatTokens } from "./ui";

export function TopBar() {
  const { project, config, connection, terminalOpen } = useApp();
  const model = useApp((s) => (connection === "online" ? s.modelStatus : "unknown"));
  const refreshModels = useApp((s) => s.refreshModels);
  const set = useApp((s) => s.set);

  useEffect(() => {
    if (connection !== "online") return;
    void refreshModels();
    const t = setInterval(() => void refreshModels(), 30_000);
    return () => clearInterval(t);
  }, [connection, config?.baseUrl, config?.provider, config?.model, refreshModels]);

  const branch = project?.git.branch;
  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-line bg-panel px-3" role="banner">
      <span className="text-[13px] font-bold tracking-tight">
        Beta<span className="text-accent">Code</span>
      </span>
      {project && (
        <button className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12.5px] text-muted hover:bg-hover hover:text-text" onClick={() => set({ dialog: "open-project" })} title={project.info.root}>
          <FolderOpen size={13} />
          <span className="max-w-[220px] truncate">{project.info.name}</span>
          {branch && (
            <span className="flex items-center gap-1 font-mono text-[11.5px] text-faint">
              <GitBranch size={11} />
              {branch}
            </span>
          )}
        </button>
      )}
      <div className="ml-auto flex items-center gap-1">
        <button className="flex items-center gap-2 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-text" onClick={() => set({ dialog: "settings", settingsTab: "models" })} aria-label="Model settings">
          <span className="max-w-[240px] truncate font-mono">{config?.model ?? "no model"}</span>
          <span className="flex items-center gap-1.5" role="status">
            <span className={clsx("h-2 w-2 rounded-full", model === "connected" ? "bg-ok" : model === "unreachable" ? "bg-bad" : "bg-faint")} aria-hidden />
            <span className={model === "connected" ? "text-ok" : model === "unreachable" ? "text-bad" : "text-faint"}>{model === "connected" ? "Connected" : model === "unreachable" ? "Not reachable" : "Checking…"}</span>
          </span>
        </button>
        <IconButton label="Command palette (Ctrl+K)" onClick={() => set({ dialog: "palette" })}>
          <Command size={15} />
        </IconButton>
        <IconButton label="Toggle terminal" onClick={() => set({ terminalOpen: !terminalOpen })} className={terminalOpen ? "text-accent" : ""}>
          <SquareTerminal size={15} />
        </IconButton>
        <IconButton label="Settings" onClick={() => set({ dialog: "settings", settingsTab: "models" })}>
          <Settings size={15} />
        </IconButton>
      </div>
    </header>
  );
}

export function StatusBar() {
  const { usage, config, connection, activeId, sessions } = useApp();
  const cost = estimateCost(usage, config?.pricing);
  const limit = usage.contextLimit || config?.contextLength || 0;
  const title = sessions.find((s) => s.id === activeId)?.title;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t border-line bg-panel px-3 font-mono text-[11px] text-faint" role="contentinfo">
      <span title="Model">{config?.model ?? "—"}</span>
      <span title="Prompt size / context window">Context: {formatTokens(usage.contextTokens)} / {limit ? formatTokens(limit) : "—"}</span>
      <span>Input: {formatTokens(usage.inputTokens)}</span>
      <span>Output: {formatTokens(usage.outputTokens)}</span>
      <span>Steps: {usage.steps}</span>
      {cost && <span>Est. cost: {cost}</span>}
      <span className="ml-auto truncate">{title}</span>
      {connection !== "online" && <span className="text-bad">runtime {connection}</span>}
      <span className="hidden md:inline">
        <Kbd>Ctrl+K</Kbd> commands
      </span>
    </footer>
  );
}

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const dismiss = useApp((s) => s.dismissToast);
  return (
    <div className="pointer-events-none fixed bottom-9 right-4 z-[60] flex w-80 flex-col gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} role="status" className={clsx("pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2 shadow-xl", t.tone === "error" ? "border-bad/50 bg-raised text-bad" : t.tone === "success" ? "border-ok/40 bg-raised text-ok" : "border-line bg-raised text-text")}>
          <span className="min-w-0 flex-1 break-words">{t.text}</span>
          <button aria-label="Dismiss" className="text-faint hover:text-text" onClick={() => dismiss(t.id)}>
            <X size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}
