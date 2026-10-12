import clsx from "clsx";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api } from "../lib/api";
import type { SearchMatch } from "../lib/types";
import { useApp } from "../stores/app";
import { Dialog, Kbd, inputClass } from "./ui";

function Picker<T>({ title, placeholder, items, render, onPick, onQuery, empty }: { title: string; placeholder: string; items: T[]; render: (item: T) => ReactNode; onPick: (item: T) => void; onQuery?: (q: string) => void; empty?: string }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const close = useApp((s) => s.set);

  useEffect(() => setSel(0), [items]);
  useEffect(() => {
    listRef.current?.children[sel]?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <Dialog title={title} onClose={() => close({ dialog: null })} width="max-w-xl">
      <div className="p-2">
        <input
          autoFocus
          className={clsx(inputClass, "font-sans")}
          placeholder={placeholder}
          aria-label={title}
          value={q}
          onChange={(e) => (setQ(e.target.value), onQuery?.(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(items.length - 1, s + 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(0, s - 1)));
            else if (e.key === "Enter" && items[sel]) onPick(items[sel]!);
          }}
        />
        <ul ref={listRef} role="listbox" className="mt-2 max-h-[50vh] overflow-y-auto">
          {items.map((it, i) => (
            <li key={i} role="option" aria-selected={i === sel} className={clsx("cursor-pointer rounded-md px-2.5 py-1.5", i === sel ? "bg-hover" : "hover:bg-hover/60")} onMouseMove={() => setSel(i)} onClick={() => onPick(it)}>
              {render(it)}
            </li>
          ))}
          {items.length === 0 && <li className="px-2.5 py-3 text-faint">{empty ?? "No results."}</li>}
        </ul>
      </div>
    </Dialog>
  );
}

interface Cmd {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
}

export function useCommands(): Cmd[] {
  const s = useApp.getState;
  return [
    { id: "new-session", label: "New Session", run: () => void s().newSession() },
    { id: "open-project", label: "Open Project…", run: () => s().set({ dialog: "open-project" }) },
    { id: "open-file", label: "Open File…", keys: "Ctrl+P", run: () => s().set({ dialog: "quick-open" }) },
    { id: "search-files", label: "Search Files…", keys: "Ctrl+Shift+P", run: () => s().set({ dialog: "search" }) },
    { id: "toggle-terminal", label: "Toggle Terminal", keys: "Ctrl+`", run: () => s().set({ terminalOpen: !s().terminalOpen }) },
    { id: "toggle-changes", label: "Toggle Changes", run: () => s().set({ rightTab: "changes", rightPanelOpen: s().rightTab !== "changes" || !s().rightPanelOpen }) },
    { id: "toggle-details", label: "Toggle Details Panel", keys: "Ctrl+Shift+B", run: () => s().set({ rightPanelOpen: !s().rightPanelOpen }) },
    { id: "model-settings", label: "Model Settings", run: () => s().set({ dialog: "settings", settingsTab: "models" }) },
    { id: "provider-settings", label: "Provider Settings", run: () => s().set({ dialog: "settings", settingsTab: "models" }) },
    { id: "local-ai", label: "Local AI Setup", run: () => s().set({ dialog: "settings", settingsTab: "local" }) },
    { id: "permissions", label: "Permissions", run: () => s().set({ dialog: "settings", settingsTab: "permissions" }) },
    { id: "git", label: "Git", run: () => s().set({ rightTab: "git", rightPanelOpen: true }) },
    { id: "compact", label: "Compact Context", run: () => void s().send("/compact") },
    { id: "clear", label: "Clear Session", run: () => void s().send("/clear") },
    { id: "doctor", label: "Run Doctor", run: () => s().set({ dialog: "settings", settingsTab: "doctor" }) },
    { id: "settings", label: "Settings", run: () => s().set({ dialog: "settings", settingsTab: "models" }) },
  ];
}

function fuzzy(label: string, q: string): boolean {
  const l = label.toLowerCase();
  let i = 0;
  for (const c of q.toLowerCase()) {
    i = l.indexOf(c, i);
    if (i < 0) return false;
    i++;
  }
  return true;
}

export function CommandPalette() {
  const cmds = useCommands();
  const set = useApp((s) => s.set);
  const [q, setQ] = useState("");
  const items = useMemo(() => cmds.filter((c) => fuzzy(c.label, q)), [cmds, q]);
  return (
    <Picker
      title="Command palette"
      placeholder="Type a command…"
      items={items}
      onQuery={setQ}
      onPick={(c) => (set({ dialog: null }), setTimeout(c.run, 0))}
      render={(c) => (
        <div className="flex items-center">
          <span>{c.label}</span>
          {c.keys && (
            <span className="ml-auto">
              <Kbd>{c.keys}</Kbd>
            </span>
          )}
        </div>
      )}
    />
  );
}

export function QuickOpen() {
  const [files, setFiles] = useState<string[]>([]);
  const set = useApp((s) => s.set);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const query = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (!q.trim()) return setFiles([]);
      api.quickOpen(q).then((r) => setFiles(r.files), () => setFiles([]));
    }, 120);
  };
  return <Picker title="Open file" placeholder="File name or glob, e.g. *.tsx" items={files} onQuery={query} empty="Type to find files." onPick={(f) => (set({ dialog: null }), void useApp.getState().openFile(f))} render={(f) => <span className="font-mono text-[12.5px]">{f}</span>} />;
}

export function SearchDialog() {
  const [matches, setMatches] = useState<SearchMatch[]>([]);
  const [error, setError] = useState<string>();
  const set = useApp((s) => s.set);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const query = (q: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (q.trim().length < 2) return setMatches([]);
      api.search(q).then(
        (r) => (setMatches(r.matches), setError(undefined)),
        (e: Error) => setError(e.message),
      );
    }, 250);
  };
  return (
    <Picker
      title="Search in files"
      placeholder="Search text in the project…"
      items={matches}
      onQuery={query}
      empty={error ?? "Type at least two characters."}
      onPick={(m) => (set({ dialog: null }), void useApp.getState().openFile(m.path))}
      render={(m) => (
        <div>
          <div className="font-mono text-[12px]">
            {m.path}
            <span className="text-faint">:{m.line}</span>
          </div>
          <div className="truncate font-mono text-[11.5px] text-muted">{m.text.trim()}</div>
        </div>
      )}
    />
  );
}
