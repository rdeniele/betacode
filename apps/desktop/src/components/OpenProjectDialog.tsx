import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { Button, Dialog, inputClass } from "./ui";

const isTauri = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function OpenProjectForm({ onOpened }: { onOpened?: () => void }) {
  const openProject = useApp((s) => s.openProject);
  const [path, setPath] = useState("");
  const [recent, setRecent] = useState<Array<{ id: string; path: string; name: string }>>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.recentProjects().then(setRecent, () => setRecent([]));
  }, []);

  const open = async (p: string) => {
    if (!p.trim()) return;
    setBusy(true);
    const ok = await openProject(p.trim());
    setBusy(false);
    if (ok) onOpened?.();
  };

  const browse = async () => {
    const { open: pick } = await import("@tauri-apps/plugin-dialog");
    const chosen = await pick({ directory: true, multiple: false, title: "Open project folder" });
    if (typeof chosen === "string") {
      setPath(chosen);
      void open(chosen);
    }
  };

  return (
    <div className="space-y-4 p-4">
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void open(path);
        }}
      >
        <input autoFocus className={inputClass} placeholder="Absolute path to a project folder, e.g. D:\work\my-app" aria-label="Project folder path" value={path} onChange={(e) => setPath(e.target.value)} />
        {isTauri() && (
          <Button type="button" onClick={() => void browse()}>
            <FolderOpen size={14} /> Browse…
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={busy || !path.trim()}>
          Open
        </Button>
      </form>
      {!isTauri() && <p className="text-[11.5px] text-faint">Browsers cannot reveal folder paths, so type the path. The desktop app adds a native folder picker.</p>}
      {recent.length > 0 && (
        <div>
          <div className="mb-1 text-[11.5px] uppercase tracking-wide text-faint">Recent projects</div>
          <ul>
            {recent.slice(0, 8).map((p) => (
              <li key={p.id}>
                <button className="flex w-full items-baseline gap-3 rounded-md px-2 py-1.5 text-left hover:bg-hover" onClick={() => void open(p.path)}>
                  <span className="font-medium">{p.name}</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-faint">{p.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function OpenProjectDialog() {
  const set = useApp((s) => s.set);
  return (
    <Dialog title="Open project" onClose={() => set({ dialog: null })} width="max-w-xl">
      <OpenProjectForm onOpened={() => set({ dialog: null })} />
    </Dialog>
  );
}
