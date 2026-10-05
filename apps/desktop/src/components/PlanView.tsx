import clsx from "clsx";
import { Check, ChevronRight, Circle, CircleDot } from "lucide-react";
import { useState } from "react";
import type { PlanItem } from "../lib/types";

export function PlanView({ plan }: { plan: PlanItem[] }) {
  const [open, setOpen] = useState(true);
  if (!plan.length) return null;
  const done = plan.filter((p) => p.status === "done").length;
  const current = plan.find((p) => p.status === "in_progress") ?? plan.find((p) => p.status === "pending");
  return (
    <div className="rounded-lg border border-line bg-panel px-3 py-2" aria-label="Task plan">
      <button className="flex w-full items-center gap-2 text-left text-[11px] uppercase tracking-wide text-faint" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight size={12} className={clsx("transition-transform", open && "rotate-90")} />
        <span>Plan</span>
        {!open && current && <span className="min-w-0 flex-1 truncate normal-case tracking-normal text-muted">{current.text}</span>}
        <span className="ml-auto">
          {done}/{plan.length}
        </span>
      </button>
      {open && (
        <ul className="mt-1.5 space-y-1">
          {plan.map((p, i) => (
            <li key={i} className={clsx("flex items-start gap-2", p.status !== "in_progress" && "text-muted")}>
              {p.status === "done" ? <Check size={14} className="mt-0.5 shrink-0 text-ok" /> : p.status === "in_progress" ? <CircleDot size={14} className="bc-pulse mt-0.5 shrink-0 text-accent" /> : <Circle size={14} className="mt-0.5 shrink-0 text-faint" />}
              <span className={clsx(p.status === "done" && "line-through decoration-faint")}>{p.text}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
