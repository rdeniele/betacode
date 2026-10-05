import clsx from "clsx";
import { ShieldAlert, ShieldQuestion } from "lucide-react";
import type { PermissionDecision, PermissionRequest } from "../lib/types";
import { Button } from "./ui";
import { DiffView } from "./DiffView";

const VERB: Record<string, string> = {
  run_command: "run",
  write_file: "write",
  edit_file: "modify",
  delete_file: "delete",
  move_file: "move",
  copy_file: "copy",
  create_directory: "create",
  read_file: "read",
  git_commit: "commit",
  git_push: "push",
};

export function PermissionCard({ request, onDecide }: { request: PermissionRequest; onDecide: (id: string, d: PermissionDecision) => void }) {
  const dangerous = request.riskLevel === "dangerous";
  const verb = VERB[request.tool] ?? request.tool;
  return (
    <div role="alertdialog" aria-label="Permission request" className={clsx("rounded-lg border bg-panel", dangerous ? "border-bad/50" : "border-warn/40")}>
      <div className="flex items-start gap-2.5 px-3.5 pt-3">
        {dangerous ? <ShieldAlert size={18} className="mt-0.5 shrink-0 text-bad" /> : <ShieldQuestion size={18} className="mt-0.5 shrink-0 text-warn" />}
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] text-muted">
            BetaCode wants to {verb}:{" "}
            <span className={clsx("ml-1 rounded px-1 text-[10.5px] font-semibold uppercase tracking-wide", dangerous ? "bg-bad/15 text-bad" : "bg-warn/15 text-warn")}>{dangerous ? "dangerous" : "needs approval"}</span>
          </div>
          <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[13px] text-text">{request.summary}</pre>
          {request.reason && <div className="mt-1 text-[12px] text-muted">{request.reason}</div>}
        </div>
      </div>
      {request.detail && (
        <div className="mx-3.5 mt-2.5 overflow-hidden rounded-md border border-line bg-bg">
          <div className="border-b border-line px-3 py-1 text-[11px] uppercase tracking-wide text-faint">Diff preview</div>
          <DiffView diff={request.detail} maxHeight="220px" />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 px-3.5 py-3">
        <Button variant="primary" onClick={() => onDecide(request.id, "allow_once")}>
          Allow once
        </Button>
        <Button onClick={() => onDecide(request.id, "allow_session")}>{dangerous ? "Allow this exact action for session" : "Allow for session"}</Button>
        {!dangerous && <Button onClick={() => onDecide(request.id, "always_allow")}>Always allow this tool</Button>}
        <Button variant="danger" onClick={() => onDecide(request.id, "deny")}>
          Deny
        </Button>
        <button className="ml-auto text-[11.5px] text-faint hover:text-bad" onClick={() => onDecide(request.id, "always_deny")}>
          Always deny
        </button>
      </div>
    </div>
  );
}
