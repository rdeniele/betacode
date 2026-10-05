import clsx from "clsx";
import { Check, CheckCheck, Redo2, Undo2, Undo } from "lucide-react";
import { useApp } from "../stores/app";
import { DiffView } from "./DiffView";
import { Button, IconButton } from "./ui";

const KIND = { added: { l: "A", c: "text-ok" }, modified: { l: "M", c: "text-warn" }, deleted: { l: "D", c: "text-bad" } } as const;

export function ChangesPanel() {
  const { changes, selectedChange, running } = useApp();
  const { acceptChange, revertChange, acceptAll, undo, redo, set } = useApp.getState();
  const active = changes.filter((c) => c.status !== "reverted");
  const pending = changes.filter((c) => c.status === "pending");
  const selected = changes.find((c) => c.id === selectedChange);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1 border-b border-line px-3 py-2">
        <span className="text-[12.5px] font-medium" data-testid="changes-summary">
          {active.length === 0 ? "No changes yet" : `${active.length} file${active.length === 1 ? "" : "s"} changed`}
        </span>
        <span className="ml-auto flex items-center gap-0.5">
          <IconButton label="Undo last change" onClick={() => void undo()} disabled={running || pending.length === 0}>
            <Undo2 size={14} />
          </IconButton>
          <IconButton label="Redo" onClick={() => void redo()} disabled={running}>
            <Redo2 size={14} />
          </IconButton>
          <Button variant="ghost" className="ml-1" onClick={() => void acceptAll()} disabled={pending.length === 0}>
            <CheckCheck size={13} /> Accept all
          </Button>
        </span>
      </div>
      <ul className="max-h-[40%] shrink-0 overflow-y-auto border-b border-line" aria-label="Changed files">
        {changes.map((c) => (
          <li key={c.id} className={clsx("group flex items-center gap-2 px-3 py-1.5", c.id === selectedChange ? "bg-hover" : "hover:bg-hover/60", c.status === "reverted" && "opacity-50")}>
            <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={() => set({ selectedChange: c.id })}>
              <span className={clsx("w-3 font-mono text-[11px] font-bold", KIND[c.kind].c)}>{KIND[c.kind].l}</span>
              <span className={clsx("min-w-0 flex-1 truncate font-mono text-[12px]", c.status === "reverted" && "line-through")}>{c.path}</span>
              <span className="font-mono text-[11px] text-ok">+{c.additions}</span>
              <span className="font-mono text-[11px] text-bad">-{c.deletions}</span>
            </button>
            {c.status === "pending" ? (
              <span className="flex shrink-0">
                <IconButton label={`Accept ${c.path}`} className="h-6 w-6 hover:text-ok" onClick={() => void acceptChange(c.id)}>
                  <Check size={13} />
                </IconButton>
                <IconButton label={`Revert ${c.path}`} className="h-6 w-6 hover:text-bad" onClick={() => void revertChange(c.id)} disabled={running}>
                  <Undo size={13} />
                </IconButton>
              </span>
            ) : (
              <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-faint">{c.status}</span>
            )}
          </li>
        ))}
        {changes.length === 0 && <li className="px-3 py-3 text-faint">Files BetaCode edits will appear here with their diffs.</li>}
      </ul>
      <div className="min-h-0 flex-1 overflow-auto">
        {selected ? (
          <>
            <div className="sticky top-0 flex items-center gap-2 border-b border-line bg-panel px-3 py-1.5">
              <span className="truncate font-mono text-[12px]">{selected.path}</span>
              <span className="ml-auto flex gap-1">
                {selected.status === "pending" && (
                  <>
                    <Button variant="primary" onClick={() => void acceptChange(selected.id)}>
                      Accept
                    </Button>
                    <Button onClick={() => void revertChange(selected.id)} disabled={running}>
                      Reject
                    </Button>
                  </>
                )}
                {selected.status === "accepted" && (
                  <Button onClick={() => void revertChange(selected.id)} disabled={running}>
                    Revert
                  </Button>
                )}
              </span>
            </div>
            <DiffView diff={selected.diff} />
          </>
        ) : (
          active.length > 0 && <div className="px-3 py-3 text-faint">Select a file to review its diff.</div>
        )}
      </div>
    </div>
  );
}
