import clsx from "clsx";
import { Terminal as XTerm } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { LineEditor } from "../lib/line-editor";
import { terminalBus } from "../lib/terminal-bus";
import { useApp } from "../stores/app";
import { IconButton } from "./ui";

const THEME = { background: "#0b0d10", foreground: "#d9dde2", cursor: "#e3a857", selectionBackground: "#3b3220" };
const USER_TERM = "user";

function useXterm(opts: { disableStdin: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<XTerm | null>(null);
  const fit = useRef<FitAddon | null>(null);
  useEffect(() => {
    const t = new XTerm({ convertEol: true, fontSize: 12.5, fontFamily: "ui-monospace, Cascadia Code, Consolas, monospace", theme: THEME, cursorBlink: !opts.disableStdin, disableStdin: opts.disableStdin, scrollback: 5000, allowProposedApi: true });
    const f = new FitAddon();
    t.loadAddon(f);
    t.open(host.current!);
    term.current = t;
    fit.current = f;
    const doFit = () => {
      try {
        f.fit();
      } catch {
        /* hidden */
      }
    };
    doFit();
    const ro = new ResizeObserver(doFit);
    ro.observe(host.current!);
    return () => {
      ro.disconnect();
      term.current = null;
      // xterm schedules viewport syncs right after open(); disposing synchronously (React StrictMode remounts)
      // makes those callbacks throw. Let them run first.
      setTimeout(() => t.dispose(), 120);
    };
  }, [opts.disableStdin]);
  return { host, term, fit };
}

function UserTerminal({ active }: { active: boolean }) {
  const { host, term, fit } = useXterm({ disableStdin: false });
  const editor = useRef(new LineEditor());
  const project = useApp((s) => s.project);

  useEffect(() => {
    const t = term.current;
    if (!t) return;
    t.writeln("\x1b[2mBetaCode terminal — each line runs as a command in the project folder. This is not an interactive shell: full-screen programs and stdin prompts are not supported.\x1b[0m");
    t.write(LineEditor.prompt);
    const sub = t.onData((data) => {
      for (const a of editor.current.feed(data)) {
        if (a.type === "write") t.write(a.text);
        else if (a.type === "interrupt") void api.terminalCancel(USER_TERM);
        else {
          editor.current.busy = true;
          api.terminalRun(USER_TERM, a.command).catch((e: Error) => {
            t.write(`\x1b[31m${e.message}\x1b[0m\r\n${LineEditor.prompt}`);
            editor.current.busy = false;
          });
        }
      }
    });
    const off = terminalBus.subscribe((m) => {
      if (m.id !== USER_TERM) return;
      if (m.kind === "output") t.write(m.chunk ?? "");
      else {
        editor.current.busy = false;
        t.write(`\r\n\x1b[2m[exit ${m.code ?? "?"}]\x1b[0m\r\n${LineEditor.prompt}`);
      }
    });
    return () => {
      sub.dispose();
      off();
    };
  }, [term, project?.info.root]);

  useEffect(() => {
    if (active) {
      fit.current?.fit();
      term.current?.focus();
    }
  }, [active, fit, term]);

  return <div ref={host} className={clsx("h-full", !active && "hidden")} aria-label="User terminal" />;
}

/** Read-only view of the commands the agent runs (kept apart from the user's terminal). */
function AgentTerminal({ active }: { active: boolean }) {
  const { host, term, fit } = useXterm({ disableStdin: true });
  const written = useRef(new Map<string, number>());
  const activeId = useApp((s) => s.activeId);

  useEffect(() => {
    written.current.clear();
    term.current?.reset();
  }, [activeId, term]);

  useEffect(() => {
    const write = () => {
      const t = term.current;
      if (!t) return;
      for (const item of useApp.getState().items) {
        if (item.kind !== "tool" || item.name !== "run_command") continue;
        const cmd = (item.args as { command?: string })?.command ?? "";
        let done = written.current.get(item.id);
        if (done === undefined) {
          t.write(`\x1b[38;5;179m$ ${cmd}\x1b[0m\r\n`);
          done = 0;
        }
        const text = item.output || (item.status !== "running" ? (item.content ?? "") : "");
        if (text.length > done) {
          t.write(text.slice(done).replace(/\r?\n/g, "\r\n"));
          done = text.length;
        }
        written.current.set(item.id, done);
      }
    };
    write();
    return useApp.subscribe(write);
  }, [term, activeId]);

  useEffect(() => {
    if (active) fit.current?.fit();
  }, [active, fit]);

  return <div ref={host} className={clsx("h-full", !active && "hidden")} aria-label="Agent terminal" />;
}

export function TerminalPanel() {
  const [tab, setTab] = useState<"user" | "agent">("user");
  const set = useApp((s) => s.set);
  return (
    <section className="flex h-[260px] shrink-0 flex-col border-t border-line bg-bg" aria-label="Terminal">
      <div role="tablist" className="flex h-8 shrink-0 items-center gap-1 border-b border-line bg-panel px-2">
        {(["user", "agent"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={clsx("rounded px-2 py-0.5 text-[11.5px] font-semibold uppercase tracking-wide", tab === t ? "text-text" : "text-faint hover:text-muted")}>
            {t === "user" ? "Terminal" : "Agent commands"}
          </button>
        ))}
        <IconButton label="Close terminal" className="ml-auto h-6 w-6" onClick={() => set({ terminalOpen: false })}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1">
        <UserTerminal active={tab === "user"} />
        <AgentTerminal active={tab === "agent"} />
      </div>
    </section>
  );
}
