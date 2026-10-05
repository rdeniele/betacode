import clsx from "clsx";
import { Check, ChevronRight, CircleSlash, FileEdit, FilePlus, FileText, FolderTree, GitBranch, ListChecks, Loader2, Search, Terminal, Users, X } from "lucide-react";
import { useState } from "react";
import { describeArgs, type ChatItem } from "../lib/chat";
import { DiffView } from "./DiffView";

type ToolItem = Extract<ChatItem, { kind: "tool" }>;

const ICONS: Record<string, typeof FileText> = {
  read_file: FileText,
  list_directory: FolderTree,
  search_files: Search,
  find_files: Search,
  search_code: Search,
  write_file: FilePlus,
  edit_file: FileEdit,
  delete_file: X,
  run_command: Terminal,
  update_plan: ListChecks,
  delegate_task: Users,
};

/** Extract the unified diff that edit/write results carry, so it can be shown inline. */
function diffOf(content?: string): string | undefined {
  if (!content) return undefined;
  const i = content.indexOf("\n--- ");
  return i >= 0 ? content.slice(i + 1) : undefined;
}

export function ToolCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[item.name] ?? (item.name.startsWith("git_") ? GitBranch : Terminal);
  const running = item.status === "running";
  const body = item.name === "run_command" && item.output ? item.output : item.content;
  const diff = item.name === "edit_file" || item.name === "write_file" ? diffOf(item.content) : undefined;
  const expandable = !!(body || diff);
  return (
    <div className={clsx("rounded-md border bg-panel", item.status === "failed" ? "border-bad/30" : item.status === "denied" ? "border-warn/30" : "border-line")} data-testid={`tool-${item.name}`}>
      <button className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left" onClick={() => expandable && setOpen((o) => !o)} aria-expanded={open} disabled={!expandable}>
        <ChevronRight size={13} className={clsx("shrink-0 text-faint transition-transform", open && "rotate-90", !expandable && "opacity-0")} />
        <Icon size={14} className="shrink-0 text-muted" />
        <span className="font-mono text-[12px] font-medium">{item.name}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted">{describeArgs(item.name, item.args)}</span>
        {running && <Loader2 size={13} className="animate-spin text-accent" aria-label="running" />}
        {item.status === "ok" && <Check size={14} className="text-ok" aria-label="succeeded" />}
        {item.status === "failed" && <X size={14} className="text-bad" aria-label="failed" />}
        {item.status === "denied" && <CircleSlash size={14} className="text-warn" aria-label="denied" />}
        {item.durationMs !== undefined && <span className="w-14 text-right font-mono text-[11px] text-faint">{item.durationMs}ms</span>}
      </button>
      {open && (
        <div className="border-t border-line">
          {diff ? <DiffView diff={diff} maxHeight="260px" /> : <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11.5px] leading-relaxed text-muted">{body}</pre>}
        </div>
      )}
      {!open && running && item.name === "run_command" && item.output && (
        <pre className="max-h-24 overflow-hidden whitespace-pre-wrap break-words border-t border-line px-3 py-1.5 font-mono text-[11px] text-faint">{item.output.slice(-400)}</pre>
      )}
    </div>
  );
}
