import clsx from "clsx";
import { PanelRightClose } from "lucide-react";
import { useApp, type RightTab } from "../stores/app";
import { ChangesPanel } from "./ChangesPanel";
import { ContextPanel } from "./ContextPanel";
import { EditorPanel } from "./EditorPanel";
import { GitPanel } from "./GitPanel";

export function RightPanel() {
  const tab = useApp((s) => s.rightTab);
  const pending = useApp((s) => s.changes.filter((c) => c.status === "pending").length);
  const set = useApp((s) => s.set);
  const open = useApp((s) => s.rightPanelOpen);
  const tabs: Array<{ id: RightTab; label: string; badge?: number }> = [
    { id: "changes", label: "Changes", badge: pending },
    { id: "editor", label: "Editor" },
    { id: "git", label: "Git" },
    { id: "context", label: "Context" },
  ];
  if (!open) return null;
  return (
    <aside id="details-panel" className="bc-details flex min-h-0 min-w-0 shrink-0 flex-col border-l border-line bg-panel" aria-label="Details">
      <div className="flex h-9 shrink-0 items-center border-b border-line px-2">
        <div role="tablist" aria-label="Details" className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set({ rightTab: t.id })} className={clsx("flex items-center gap-1.5 rounded px-2 py-1 text-[11.5px] font-semibold uppercase tracking-wide", tab === t.id ? "text-text" : "text-faint hover:text-muted")}>
              {t.label}
              {!!t.badge && <span className="rounded-full bg-accent px-1.5 text-[10px] font-bold text-on-accent">{t.badge}</span>}
            </button>
          ))}
        </div>
        <button aria-label="Close details panel" title="Close details (Ctrl+Shift+B)" onClick={() => set({ rightPanelOpen: false })} className="ml-1 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted hover:bg-hover hover:text-text">
          <PanelRightClose size={15} />
        </button>
      </div>
      {tab === "changes" && <ChangesPanel />}
      {tab === "editor" && <EditorPanel />}
      {tab === "git" && <GitPanel />}
      {tab === "context" && <ContextPanel />}
    </aside>
  );
}
