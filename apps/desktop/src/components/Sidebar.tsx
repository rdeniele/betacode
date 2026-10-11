import clsx from "clsx";
import { ChevronRight, Cpu, FolderTree, GitBranch, Brain, History, Menu, MessageSquare, Palette, Plus, Search, SquareTerminal, FileDiff } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useApp, type RightTab } from "../stores/app";
import { FileTree } from "./FileTree";
import { SessionList } from "./SessionList";

function NavItem({ icon, label, onClick, badge, trailing, active, accent }: { icon: ReactNode; label: string; onClick: () => void; badge?: number; trailing?: ReactNode; active?: boolean; accent?: boolean }) {
  return (
    <button onClick={onClick} className={clsx("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left hover:bg-hover", active ? "bg-hover text-text" : accent ? "text-accent" : "text-muted hover:text-text")}>
      <span className="shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {!!badge && <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-on-accent">{badge}</span>}
      {trailing}
    </button>
  );
}

function Group({ title, icon, open, onToggle, children }: { title: string; icon: ReactNode; open: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section>
      <button onClick={onToggle} aria-expanded={open} className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-muted hover:bg-hover hover:text-text">
        <span className="shrink-0">{icon}</span>
        <span className="flex-1">{title}</span>
        <ChevronRight size={13} className={clsx("transition-transform", open && "rotate-90")} />
      </button>
      {open && children}
    </section>
  );
}

export function Sidebar() {
  const open = useApp((s) => s.sidebarOpen);
  const project = useApp((s) => s.project);
  const pending = useApp((s) => s.changes.filter((c) => c.status === "pending").length);
  const modelStatus = useApp((s) => s.modelStatus);
  const running = useApp((s) => s.running);
  const set = useApp((s) => s.set);
  const newSession = useApp((s) => s.newSession);
  const [groups, setGroups] = useState({ sessions: true, files: true });
  const toggleGroup = (g: keyof typeof groups) => setGroups((x) => ({ ...x, [g]: !x[g] }));
  const goRight = (tab: RightTab) => set({ rightTab: tab });
  const dot = modelStatus === "connected" ? (running ? "bc-pulse bg-accent" : "bg-ok") : modelStatus === "unreachable" ? "bg-bad" : "bg-faint";
  const statusText = modelStatus === "connected" ? (running ? "working" : "ready") : modelStatus === "unreachable" ? "offline" : "…";

  if (!open) {
    const rail = (label: string, icon: ReactNode, onClick: () => void) => (
      <button key={label} aria-label={label} title={label} onClick={onClick} className="flex h-9 w-9 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text">
        {icon}
      </button>
    );
    return (
      <aside className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-line bg-panel py-2" aria-label="Sidebar (collapsed)">
        <img src="/brand/betacode-icon.png" alt="BetaCode" width={32} height={32} className="mb-1 rounded-md" />
        {rail("Expand sidebar", <Menu size={16} />, () => set({ sidebarOpen: true }))}
        {rail("New session", <Plus size={16} />, () => void newSession())}
        {rail("Search in files", <Search size={16} />, () => set({ dialog: "search" }))}
        {rail("Changes", <FileDiff size={16} />, () => goRight("changes"))}
        {rail("Git", <GitBranch size={16} />, () => goRight("git"))}
        {rail("Local AI", <Cpu size={16} />, () => set({ dialog: "settings", settingsTab: "local" }))}
      </aside>
    );
  }

  return (
    <aside className="flex w-[256px] shrink-0 flex-col border-r border-line bg-panel" aria-label="Sidebar">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-2">
        <button aria-label="Collapse sidebar" title="Collapse sidebar" onClick={() => set({ sidebarOpen: false })} className="flex h-7 w-7 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-text">
          <Menu size={15} />
        </button>
        <span className="min-w-0 flex-1 truncate text-right text-[12.5px] font-semibold" title={project?.info.root}>
          {project?.info.name ?? "BetaCode"}
        </span>
      </div>
      <nav className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5 text-[12.5px]" aria-label="Navigation">
        <NavItem icon={<Plus size={15} />} label="New session" onClick={() => void newSession()} accent />
        <NavItem icon={<Search size={15} />} label="Search" onClick={() => set({ dialog: "search" })} />
        <Group title="Sessions" icon={<MessageSquare size={15} />} open={groups.sessions} onToggle={() => toggleGroup("sessions")}>
          <div className="mb-1 ml-3 max-h-64 overflow-y-auto border-l border-line">
            <SessionList compact />
          </div>
        </Group>
        <Group title="Files" icon={<FolderTree size={15} />} open={groups.files} onToggle={() => toggleGroup("files")}>
          <div className="mb-1 ml-3 border-l border-line">
            <FileTree />
          </div>
        </Group>
        <div className="px-2.5 pb-0.5 pt-3 text-[10.5px] font-semibold uppercase tracking-wider text-faint">Tools</div>
        <NavItem icon={<FileDiff size={15} />} label="Changes" badge={pending} onClick={() => goRight("changes")} />
        <NavItem icon={<GitBranch size={15} />} label="Git" onClick={() => goRight("git")} />
        <NavItem icon={<Brain size={15} />} label="Context & memory" onClick={() => goRight("context")} />
        <NavItem icon={<SquareTerminal size={15} />} label="Terminal" onClick={() => set({ terminalOpen: !useApp.getState().terminalOpen })} />
        <NavItem
          icon={<Cpu size={15} />}
          label="Local AI"
          onClick={() => set({ dialog: "settings", settingsTab: "local" })}
          trailing={
            <span className="flex items-center gap-1.5 text-[11px] text-faint">
              {statusText}
              <span className={clsx("h-2 w-2 rounded-full", dot)} aria-hidden />
            </span>
          }
        />
        <NavItem icon={<History size={15} />} label="Open project…" onClick={() => set({ dialog: "open-project" })} />
        <NavItem icon={<Palette size={15} />} label="Appearance" onClick={() => set({ dialog: "settings", settingsTab: "appearance" })} />
      </nav>
    </aside>
  );
}
