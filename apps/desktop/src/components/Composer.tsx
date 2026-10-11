import clsx from "clsx";
import { ArrowUp, Check, ChevronDown, Cpu, Search, Square, SquareTerminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentMode } from "../lib/types";
import { useApp } from "../stores/app";
import { Kbd } from "./ui";

export const SLASH_COMMANDS: Array<{ name: string; help: string }> = [
  { name: "/help", help: "List commands" },
  { name: "/init", help: "Analyse the repo and create BETACODE.md" },
  { name: "/compact", help: "Summarise older conversation to free context" },
  { name: "/clear", help: "Clear the conversation" },
  { name: "/diff", help: "List changes made in this session" },
  { name: "/undo", help: "Revert the most recent change" },
  { name: "/redo", help: "Re-apply the last reverted change" },
  { name: "/status", help: "Model, context and git status" },
  { name: "/model", help: "Open model settings" },
  { name: "/provider", help: "Open provider settings" },
  { name: "/sessions", help: "Show saved sessions" },
  { name: "/settings", help: "Open settings" },
  { name: "/doctor", help: "Check environment and model endpoint" },
];

export const MODES: Array<{ id: AgentMode; label: string; help: string }> = [
  { id: "code", label: "Agent", help: "Reads, edits and runs commands to finish the task" },
  { id: "ask", label: "Chat", help: "Answers questions about the project; changes nothing" },
  { id: "plan", label: "Plan", help: "Produces a plan for you to approve; changes nothing" },
  { id: "review", label: "Review", help: "Reviews your current changes" },
  { id: "debug", label: "Debug", help: "Reproduces and fixes an error" },
  { id: "explore", label: "Explore", help: "Maps an unfamiliar codebase" },
];

export function slashSuggestions(text: string): typeof SLASH_COMMANDS {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(text.toLowerCase()));
}

function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, close]);
  return ref;
}

function ModelPicker() {
  const config = useApp((s) => s.config);
  const models = useApp((s) => s.availableModels);
  const setModel = useApp((s) => s.setModel);
  const refreshModels = useApp((s) => s.refreshModels);
  const set = useApp((s) => s.set);
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const current = config?.model ?? "no model";
  return (
    <div ref={ref} className="relative">
      <button
        className="flex max-w-[220px] items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-muted hover:bg-hover hover:text-text"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${current}`}
        onClick={() => {
          setOpen((o) => !o);
          void refreshModels();
        }}
      >
        <Cpu size={13} className="shrink-0" />
        <span className="truncate">{current}</span>
        <ChevronDown size={12} className="shrink-0" />
      </button>
      {open && (
        <div role="listbox" aria-label="Models" className="absolute bottom-full right-0 z-30 mb-1.5 w-72 overflow-hidden rounded-lg border border-line bg-raised shadow-xl">
          <div className="max-h-56 overflow-y-auto py-1">
            {models.length === 0 && <div className="px-3 py-2 text-faint">No models reported by the endpoint.</div>}
            {models.map((m) => (
              <button
                key={m}
                role="option"
                aria-selected={m === config?.model}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-hover"
                onClick={() => {
                  setOpen(false);
                  void setModel(m);
                }}
              >
                <Check size={12} className={clsx("shrink-0", m === config?.model ? "text-accent" : "opacity-0")} />
                <span className="truncate font-mono text-[12px]">{m}</span>
              </button>
            ))}
          </div>
          <button
            className="w-full border-t border-line px-3 py-2 text-left text-[12px] text-accent hover:bg-hover"
            onClick={() => {
              setOpen(false);
              set({ dialog: "settings", settingsTab: "local" });
            }}
          >
            Local AI setup &amp; recommendations…
          </button>
        </div>
      )}
    </div>
  );
}

function ModeSwitch({ mode, onMode }: { mode: AgentMode; onMode: (m: AgentMode) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const basic = mode === "code" || mode === "ask";
  const extra = !basic ? MODES.find((m) => m.id === mode) : undefined;
  const seg = (id: AgentMode, label: string, help: string) => (
    <button key={id} aria-pressed={mode === id} title={help} onClick={() => onMode(id)} className={clsx("rounded-full px-3 py-1 text-[12px] transition-colors", mode === id ? "bg-hover text-text" : "text-faint hover:text-muted")}>
      {label}
    </button>
  );
  return (
    <div ref={ref} className="relative" role="group" aria-label="Mode">
      <div className="flex items-center rounded-full border border-line p-0.5">
        {seg("code", "Agent", MODES[0]!.help)}
        {seg("ask", "Chat", MODES[1]!.help)}
        {extra && seg(extra.id, extra.label, extra.help)}
        <button aria-label="More modes" aria-expanded={open} className="rounded-full px-1.5 py-1 text-faint hover:text-text" onClick={() => setOpen((o) => !o)}>
          <ChevronDown size={12} />
        </button>
      </div>
      {open && (
        <div role="menu" className="absolute bottom-full right-0 z-30 mb-1.5 w-64 overflow-hidden rounded-lg border border-line bg-raised py-1 shadow-xl">
          {MODES.map((m) => (
            <button
              key={m.id}
              role="menuitemradio"
              aria-checked={m.id === mode}
              className="flex w-full flex-col px-3 py-1.5 text-left hover:bg-hover"
              onClick={() => {
                onMode(m.id);
                setOpen(false);
              }}
            >
              <span className={clsx("text-[12.5px]", m.id === mode && "text-accent")}>{m.label}</span>
              <span className="text-[11px] text-faint">{m.help}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function Composer({
  running,
  disabled,
  mode,
  onMode,
  onSend,
  onStop,
  hero,
}: {
  running: boolean;
  disabled?: boolean;
  mode: AgentMode;
  onMode: (m: AgentMode) => void;
  onSend: (text: string) => void;
  onStop: () => void;
  /** Large, centred variant used on the welcome screen. */
  hero?: boolean;
}) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const suggestions = useMemo(() => slashSuggestions(text), [text]);
  const terminalOpen = useApp((s) => s.terminalOpen);
  const set = useApp((s) => s.set);

  const submit = () => {
    const t = text.trim();
    if (!t || running || disabled) return;
    onSend(t);
    setText("");
  };

  return (
    <div className={clsx(hero ? "w-full" : "border-t border-line bg-panel p-3")}>
      <div className={clsx("relative mx-auto", hero ? "max-w-2xl" : "max-w-3xl")}>
        {suggestions.length > 0 && (
          <ul role="listbox" aria-label="Commands" className="absolute bottom-full left-0 right-0 z-20 mb-1.5 overflow-hidden rounded-lg border border-line bg-raised shadow-xl">
            {suggestions.map((c, i) => (
              <li
                key={c.name}
                role="option"
                aria-selected={i === sel}
                className={clsx("flex cursor-pointer items-baseline gap-3 px-3 py-1.5", i === sel && "bg-hover")}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setText(c.name + " ");
                  ref.current?.focus();
                }}
              >
                <span className="font-mono text-accent">{c.name}</span>
                <span className="text-muted">{c.help}</span>
              </li>
            ))}
          </ul>
        )}
        <div className={clsx("rounded-2xl border border-line bg-bg shadow-sm transition-colors focus-within:border-accent/60", hero && "shadow-lg")}>
          <textarea
            ref={ref}
            value={text}
            rows={Math.min(8, Math.max(hero ? 3 : 2, text.split("\n").length))}
            placeholder={disabled ? "Open a project to start" : "Message BetaCode…   (/ for commands)"}
            disabled={disabled}
            aria-label="Message BetaCode"
            className="block w-full resize-none bg-transparent px-4 pt-3 text-[13.5px] leading-relaxed placeholder:text-faint focus:outline-none"
            onChange={(e) => {
              setText(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              if (suggestions.length) {
                if (e.key === "ArrowDown") return (e.preventDefault(), setSel((s) => (s + 1) % suggestions.length));
                if (e.key === "ArrowUp") return (e.preventDefault(), setSel((s) => (s - 1 + suggestions.length) % suggestions.length));
                if (e.key === "Tab" || (e.key === "Enter" && !e.metaKey && !e.ctrlKey && text !== suggestions[sel]!.name)) {
                  e.preventDefault();
                  return setText(suggestions[sel]!.name + " ");
                }
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
              if (e.key === "Escape" && running) onStop();
            }}
          />
          <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
            <button aria-label="Toggle terminal" aria-pressed={terminalOpen} title="Terminal" onClick={() => set({ terminalOpen: !terminalOpen })} className={clsx("rounded-lg border border-line p-1.5 hover:bg-hover", terminalOpen ? "text-accent" : "text-muted")}>
              <SquareTerminal size={14} />
            </button>
            <button aria-label="Search files" title="Search in files (Ctrl+Shift+P)" onClick={() => set({ dialog: "search" })} className="rounded-lg border border-line p-1.5 text-muted hover:bg-hover">
              <Search size={14} />
            </button>
            <span className="ml-1 hidden whitespace-nowrap text-[11px] text-faint min-[1500px]:inline">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <ModelPicker />
              <ModeSwitch mode={mode} onMode={onMode} />
              {running ? (
                <button onClick={onStop} aria-label="Stop" title="Stop (Esc)" className="flex h-8 w-8 items-center justify-center rounded-full bg-bad/20 text-bad hover:bg-bad/30">
                  <Square size={12} fill="currentColor" />
                </button>
              ) : (
                <button onClick={submit} disabled={!text.trim() || disabled} aria-label="Send" title="Send (Enter)" className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-on-accent hover:brightness-110 disabled:opacity-30">
                  <ArrowUp size={15} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
