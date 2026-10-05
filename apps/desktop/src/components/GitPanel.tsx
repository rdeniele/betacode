import { GitBranch, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { useApp } from "../stores/app";
import { DiffView } from "./DiffView";
import { Button, IconButton, inputClass } from "./ui";

export function GitPanel() {
  const git = useApp((s) => s.git);
  const refresh = useApp((s) => s.refreshGit);
  const toast = useApp((s) => s.toast);
  const [message, setMessage] = useState("");
  const [diff, setDiff] = useState("");
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<Array<{ shortHash: string; subject: string }>>([]);

  const load = async () => {
    await refresh();
    const [d, l] = await Promise.all([api.gitDiff().catch(() => ({ diff: "" })), api.gitLog().catch(() => ({ commits: [] }))]);
    setDiff(d.diff);
    setLog(l.commits);
  };
  useEffect(() => void load(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, "success");
      await load();
    } catch (e) {
      toast((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  if (git === null || git === undefined) return <div className="p-4 text-faint">{git === null ? "This project is not a git repository." : "Loading…"}</div>;
  const unstaged = [...git.modified.map((f) => f.path), ...git.untracked];
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <GitBranch size={14} className="text-muted" />
        <span className="font-mono text-[12.5px]">{git.branch ?? "(detached)"}</span>
        {git.upstream && (
          <span className="font-mono text-[11px] text-faint">
            ↑{git.ahead} ↓{git.behind}
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          <IconButton label="Refresh git status" onClick={() => void load()}>
            <RefreshCw size={13} />
          </IconButton>
          <Button variant="ghost" disabled={busy || !git.upstream} onClick={() => window.confirm("Pull (fast-forward only) from the upstream branch?") && void act(() => api.gitPull(), "Pulled")}>
            Pull
          </Button>
          <Button variant="ghost" disabled={busy || git.ahead === 0} onClick={() => window.confirm(`Push ${git.ahead} commit(s) to ${git.upstream}?`) && void act(() => api.gitPush(), "Pushed")}>
            Push
          </Button>
        </span>
      </div>
      <div className="space-y-3 p-3">
        {git.clean && <div className="text-muted">Working tree clean.</div>}
        <Group title={`Staged (${git.staged.length})`} files={git.staged.map((f) => f.path)} />
        <Group title={`Changes (${unstaged.length})`} files={unstaged} />
        {(unstaged.length > 0 || git.staged.length > 0) && (
          <div className="space-y-2 rounded-md border border-line bg-panel p-2.5">
            <input className={inputClass} placeholder="Commit message" aria-label="Commit message" value={message} onChange={(e) => setMessage(e.target.value)} />
            <div className="flex gap-2">
              <Button disabled={busy || unstaged.length === 0} onClick={() => void act(() => api.gitAdd(unstaged), "Staged all changes")}>
                Stage all
              </Button>
              <Button variant="primary" disabled={busy || !message.trim() || git.staged.length === 0} onClick={() => void act(async () => (await api.gitCommit(message.trim()), setMessage("")), "Committed")}>
                Commit staged
              </Button>
            </div>
            <p className="text-[11.5px] text-faint">BetaCode never commits or pushes on its own; these buttons are you.</p>
          </div>
        )}
        {diff.trim() && (
          <details>
            <summary className="cursor-pointer text-[11.5px] uppercase tracking-wide text-faint">Working tree diff</summary>
            <div className="mt-1 overflow-hidden rounded-md border border-line">
              <DiffView diff={diff} maxHeight="300px" />
            </div>
          </details>
        )}
        {log.length > 0 && (
          <div>
            <div className="mb-1 text-[11.5px] uppercase tracking-wide text-faint">Recent commits</div>
            <ul className="space-y-0.5">
              {log.slice(0, 10).map((c) => (
                <li key={c.shortHash} className="flex gap-2">
                  <span className="font-mono text-faint">{c.shortHash}</span>
                  <span className="truncate">{c.subject}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

function Group({ title, files }: { title: string; files: string[] }) {
  if (!files.length) return null;
  return (
    <div>
      <div className="mb-1 text-[11.5px] uppercase tracking-wide text-faint">{title}</div>
      <ul className="space-y-0.5 font-mono text-[12px]">
        {files.map((f) => (
          <li key={f} className="truncate">
            {f}
          </li>
        ))}
      </ul>
    </div>
  );
}
