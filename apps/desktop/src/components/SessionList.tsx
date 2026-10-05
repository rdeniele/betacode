import clsx from "clsx";
import { Copy, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useApp } from "../stores/app";
import { IconButton, inputClass } from "./ui";

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export function SessionList() {
  const { sessions, activeId, running } = useApp();
  const { newSession, selectSession, deleteSession, renameSession, duplicateSession, refreshSessions } = useApp.getState();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string>();
  const [draft, setDraft] = useState("");

  useEffect(() => {
    const t = setTimeout(() => void refreshSessions(query || undefined), 200);
    return () => clearTimeout(t);
  }, [query, refreshSessions]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 p-2">
        <div className="relative flex-1">
          <Search size={12} className="absolute left-2 top-2 text-faint" />
          <input className={clsx(inputClass, "pl-7 font-sans")} placeholder="Search sessions" aria-label="Search sessions" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <IconButton label="New session" onClick={() => void newSession()}>
          <Plus size={15} />
        </IconButton>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2" aria-label="Sessions">
        {sessions.map((s) => (
          <li key={s.id} className={clsx("group flex items-center gap-1.5 rounded-md px-2 py-1.5", s.id === activeId ? "bg-hover" : "hover:bg-hover/60")}>
            {editing === s.id ? (
              <input
                autoFocus
                className={clsx(inputClass, "py-0.5 font-sans")}
                value={draft}
                aria-label="Session title"
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => setEditing(undefined)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && draft.trim()) void renameSession(s.id, draft.trim()).then(() => setEditing(undefined));
                  if (e.key === "Escape") setEditing(undefined);
                }}
              />
            ) : (
              <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => void selectSession(s.id)}>
                <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", s.id === activeId ? (running ? "bc-pulse bg-accent" : "bg-accent") : "bg-faint")} aria-hidden />
                <span className="min-w-0 flex-1 truncate">{s.title}</span>
                <span className="font-mono text-[10.5px] text-faint group-hover:hidden">{ago(s.updatedAt)}</span>
              </button>
            )}
            {editing !== s.id && (
              <span className="hidden shrink-0 group-hover:flex">
                <IconButton label="Rename session" className="h-6 w-6" onClick={() => (setEditing(s.id), setDraft(s.title))}>
                  <Pencil size={12} />
                </IconButton>
                <IconButton label="Duplicate session" className="h-6 w-6" onClick={() => void duplicateSession(s.id)}>
                  <Copy size={12} />
                </IconButton>
                <IconButton label="Delete session" className="h-6 w-6 hover:text-bad" onClick={() => window.confirm(`Delete "${s.title}"?`) && void deleteSession(s.id)}>
                  <Trash2 size={12} />
                </IconButton>
              </span>
            )}
          </li>
        ))}
        {sessions.length === 0 && <li className="px-2 py-3 text-faint">{query ? "No sessions match." : "No sessions yet."}</li>}
      </ul>
    </div>
  );
}
