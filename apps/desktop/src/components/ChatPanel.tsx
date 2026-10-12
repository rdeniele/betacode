import { useApp } from "../stores/app";
import { FileDiff, PanelRightOpen } from "lucide-react";
import { Composer } from "./Composer";
import { Hero } from "./Hero";
import { MessageList } from "./MessageList";
import { PermissionCard } from "./PermissionCard";
import { PlanView } from "./PlanView";
import { STATE_META, StateDot } from "./ui";

export function ChatPanel() {
  const { items, plan, pending, running, agentState, agentDetail, mode, project, activeId } = useApp();
  const send = useApp((s) => s.send);
  const cancel = useApp((s) => s.cancel);
  const decide = useApp((s) => s.decide);
  const setMode = useApp((s) => s.setMode);
  const set = useApp((s) => s.set);
  const detailsOpen = useApp((s) => s.rightPanelOpen);
  const pendingChanges = useApp((s) => s.changes.filter((c) => c.status === "pending").length);
  const meta = STATE_META[agentState] ?? STATE_META.IDLE!;
  const showState = running || agentState !== "IDLE";
  const empty = items.length === 0 && !running && pending.length === 0 && plan.length === 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Chat">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-4 text-[12px]">
        <span className="font-medium text-muted">Chat</span>
        {showState && (
          <span className="flex min-w-0 items-center gap-2" role="status" aria-live="polite">
            <StateDot state={agentState} />
            <span className="text-text">{running ? `BetaCode is working — ${meta.label}` : meta.label}</span>
            {running && agentDetail && <span className="max-w-[260px] truncate font-mono text-faint">{agentDetail}</span>}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {pendingChanges > 0 && <button onClick={() => set({ rightTab: "changes", rightPanelOpen: true })} className="flex items-center gap-1.5 rounded px-2 py-1 text-accent hover:bg-hover" aria-label={`Review ${pendingChanges} pending changes`}><FileDiff size={13} /> {pendingChanges} changes</button>}
          <button onClick={() => set({ rightPanelOpen: !detailsOpen })} aria-label="Toggle details panel" aria-expanded={detailsOpen} aria-controls="details-panel" title="Details (Ctrl+Shift+B)" className="flex h-7 w-7 items-center justify-center rounded text-muted hover:bg-hover hover:text-text"><PanelRightOpen size={15} /></button>
        </div>
      </div>
      {empty && project && activeId ? (
        <Hero running={running} mode={mode} onMode={setMode} onSend={(t) => void send(t)} onStop={() => void cancel()} />
      ) : (
        <>
          <MessageList items={items} />
          <div className="mx-auto flex max-h-[55%] w-full max-w-3xl shrink-0 flex-col gap-2.5 overflow-y-auto px-4 pb-2">
            <PlanView plan={plan} />
            {pending.map((p) => (
              <PermissionCard key={p.id} request={p} onDecide={decide} />
            ))}
          </div>
          <Composer running={running} disabled={!project || !activeId} mode={mode} onMode={setMode} onSend={(t) => void send(t)} onStop={() => void cancel()} />
        </>
      )}
    </section>
  );
}
