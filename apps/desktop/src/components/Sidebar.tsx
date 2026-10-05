import clsx from "clsx";
import { useApp, type LeftTab } from "../stores/app";
import { FileTree } from "./FileTree";
import { SessionList } from "./SessionList";

const TABS: Array<{ id: LeftTab; label: string }> = [
  { id: "files", label: "Project" },
  { id: "sessions", label: "Sessions" },
];

export function Sidebar() {
  const tab = useApp((s) => s.leftTab);
  const set = useApp((s) => s.set);
  const project = useApp((s) => s.project);
  return (
    <aside className="flex w-[250px] shrink-0 flex-col border-r border-line bg-panel" aria-label="Sidebar">
      <div role="tablist" className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set({ leftTab: t.id })} className={clsx("rounded px-2 py-1 text-[11.5px] font-semibold uppercase tracking-wide", tab === t.id ? "text-text" : "text-faint hover:text-muted")}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "files" && project && <div className="truncate border-b border-line px-3 py-1.5 font-mono text-[11px] text-faint" title={project.info.root}>{project.info.name}</div>}
      <div className="min-h-0 flex-1 overflow-y-auto">{tab === "files" ? <FileTree /> : <SessionList />}</div>
    </aside>
  );
}
