import { useApp } from "../stores/app";
import { Composer } from "./Composer";
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
  const meta = STATE_META[agentState] ?? STATE_META.IDLE!;
  const showState = running || agentState !== "IDLE";

  return (
    <section className="flex min-w-0 flex-1 flex-col bg-bg" aria-label="Chat">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-line px-4 text-[12px]">
        <span className="font-medium text-muted">Chat</span>
        {showState && (
          <span className="ml-auto flex items-center gap-2" role="status" aria-live="polite">
            <StateDot state={agentState} />
            <span className="text-text">{running ? `BetaCode is working — ${meta.label}` : meta.label}</span>
            {running && agentDetail && <span className="max-w-[260px] truncate font-mono text-faint">{agentDetail}</span>}
          </span>
        )}
      </div>
      <MessageList items={items} />
      <div className="mx-auto flex max-h-[55%] w-full max-w-3xl shrink-0 flex-col gap-2.5 overflow-y-auto px-4 pb-2">
        <PlanView plan={plan} />
        {pending.map((p) => (
          <PermissionCard key={p.id} request={p} onDecide={decide} />
        ))}
      </div>
      <Composer running={running} disabled={!project || !activeId} mode={mode} onMode={setMode} onSend={(t) => void send(t)} onStop={() => void cancel()} />
    </section>
  );
}
