import clsx from "clsx";
import { useApp, type RightTab } from "../stores/app";
import { ChangesPanel } from "./ChangesPanel";
import { ContextPanel } from "./ContextPanel";
import { EditorPanel } from "./EditorPanel";
import { GitPanel } from "./GitPanel";

export function RightPanel() {
  const tab = useApp((s) => s.rightTab);
  const pending = useApp((s) => s.changes.filter((c) => c.status === "pending").length);
  const set = useApp((s) => s.set);
  const tabs: Array<{ id: RightTab; label: string; badge?: number }> = [
    { id: "changes", label: "Changes", badge: pending },
    { id: "editor", label: "Editor" },
    { id: "git", label: "Git" },
    { id: "context", label: "Context" },
  ];
  return (
    <aside className="flex w-[40%] min-w-[340px] max-w-[760px] shrink-0 flex-col border-l border-line bg-panel" aria-label="Details">
      <div role="tablist" className="flex h-9 shrink-0 items-center gap-1 border-b border-line px-2">
        {tabs.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set({ rightTab: t.id })} className={clsx("flex items-center gap-1.5 rounded px-2 py-1 text-[11.5px] font-semibold uppercase tracking-wide", tab === t.id ? "text-text" : "text-faint hover:text-muted")}>
            {t.label}
            {!!t.badge && <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-black">{t.badge}</span>}
          </button>
        ))}
      </div>
      {tab === "changes" && <ChangesPanel />}
      {tab === "editor" && <EditorPanel />}
      {tab === "git" && <GitPanel />}
      {tab === "context" && <ContextPanel />}
    </aside>
  );
}
