import clsx from "clsx";
import { ChevronRight, File, Folder } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../lib/api";
import type { DirEntry } from "../lib/types";
import { useApp } from "../stores/app";

function badge(path: string, git: ReturnType<typeof useApp.getState>["git"], changed: Map<string, string>): { text: string; cls: string } | undefined {
  const c = changed.get(path);
  if (c) return { text: c, cls: "text-accent" };
  if (!git) return undefined;
  if (git.untracked.includes(path)) return { text: "U", cls: "text-ok" };
  if (git.modified.some((f) => f.path === path) || git.staged.some((f) => f.path === path)) return { text: "M", cls: "text-warn" };
  return undefined;
}

function Node({ entry, depth, changed }: { entry: DirEntry; depth: number; changed: Map<string, string> }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | undefined>(entry.children);
  const version = useApp((s) => s.treeVersion);
  const git = useApp((s) => s.git);
  const openFile = useApp((s) => s.openFile);
  const active = useApp((s) => s.activeTab === entry.path);

  const load = useCallback(async () => {
    try {
      setChildren((await api.tree(entry.path, 1)).children ?? []);
    } catch {
      setChildren([]);
    }
  }, [entry.path]);

  useEffect(() => {
    if (open) void load();
  }, [open, version, load]);

  const b = entry.type === "file" ? badge(entry.path, git, changed) : undefined;
  return (
    <li>
      <button
        className={clsx("flex w-full items-center gap-1 rounded px-1.5 py-[3px] text-left hover:bg-hover", active && "bg-hover text-text")}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={() => (entry.type === "dir" ? setOpen((o) => !o) : void openFile(entry.path))}
        aria-expanded={entry.type === "dir" ? open : undefined}
      >
        {entry.type === "dir" ? <ChevronRight size={12} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90")} /> : <span className="w-3 shrink-0" />}
        {entry.type === "dir" ? <Folder size={13} className="shrink-0 text-muted" /> : <File size={13} className="shrink-0 text-faint" />}
        <span className="min-w-0 flex-1 truncate">{entry.name}</span>
        {b && <span className={clsx("font-mono text-[10.5px] font-semibold", b.cls)}>{b.text}</span>}
      </button>
      {open && children && (
        <ul>
          {children.map((c) => (
            <Node key={c.path} entry={c} depth={depth + 1} changed={changed} />
          ))}
          {children.length === 0 && <li className="py-0.5 text-faint" style={{ paddingLeft: 30 + depth * 12 }}>empty</li>}
        </ul>
      )}
    </li>
  );
}

export function FileTree() {
  const project = useApp((s) => s.project);
  const version = useApp((s) => s.treeVersion);
  const changes = useApp((s) => s.changes);
  const [root, setRoot] = useState<DirEntry[]>([]);

  useEffect(() => {
    if (!project) return setRoot([]);
    api.tree(".", 1).then((t) => setRoot(t.children ?? []), () => setRoot([]));
  }, [project, version]);

  const changed = new Map(changes.filter((c) => c.status === "pending").map((c) => [c.path, c.kind === "added" ? "A" : c.kind === "deleted" ? "D" : "M"]));
  if (!project) return <div className="p-3 text-faint">No project open.</div>;
  return (
    <ul className="px-1 py-1 text-[12.5px]" aria-label="Project files">
      {root.map((e) => (
        <Node key={e.path} entry={e} depth={0} changed={changed} />
      ))}
    </ul>
  );
}
