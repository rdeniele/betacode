import clsx from "clsx";
import { ArrowUp, Square } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import type { AgentMode } from "../lib/types";
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

const MODES: Array<{ id: AgentMode; label: string; help: string }> = [
  { id: "code", label: "Code", help: "Modify the project and run tools" },
  { id: "ask", label: "Ask", help: "Answer questions; no changes" },
  { id: "plan", label: "Plan", help: "Produce a plan; no changes" },
  { id: "review", label: "Review", help: "Review current changes" },
  { id: "debug", label: "Debug", help: "Reproduce and fix errors" },
  { id: "explore", label: "Explore", help: "Understand the codebase" },
];

export function slashSuggestions(text: string): typeof SLASH_COMMANDS {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(text.toLowerCase()));
}

export function Composer({
  running,
  disabled,
  mode,
  onMode,
  onSend,
  onStop,
}: {
  running: boolean;
  disabled?: boolean;
  mode: AgentMode;
  onMode: (m: AgentMode) => void;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState("");
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);
  const suggestions = useMemo(() => slashSuggestions(text), [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || running || disabled) return;
    onSend(t);
    setText("");
  };

  return (
    <div className="border-t border-line bg-panel p-3">
      <div className="relative mx-auto max-w-3xl">
        {suggestions.length > 0 && (
          <ul role="listbox" aria-label="Commands" className="absolute bottom-full left-0 right-0 mb-1.5 overflow-hidden rounded-lg border border-line bg-raised shadow-xl">
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
        <div className="rounded-lg border border-line bg-bg focus-within:border-accent/60">
          <textarea
            ref={ref}
            value={text}
            rows={Math.min(8, Math.max(2, text.split("\n").length))}
            placeholder={disabled ? "Open a project to start" : "Ask BetaCode…   (/ for commands)"}
            disabled={disabled}
            aria-label="Message BetaCode"
            className="block w-full resize-none bg-transparent px-3 pt-2.5 text-[13.5px] leading-relaxed placeholder:text-faint focus:outline-none"
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
          <div className="flex items-center gap-2 px-2 pb-2 pt-1">
            <label className="sr-only" htmlFor="bc-mode">
              Mode
            </label>
            <select id="bc-mode" value={mode} onChange={(e) => onMode(e.target.value as AgentMode)} className="rounded-md border border-line bg-raised px-1.5 py-1 text-[12px] text-text" title={MODES.find((m) => m.id === mode)?.help}>
              {MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
            <span className="hidden text-[11.5px] text-faint sm:inline">
              <Kbd>Enter</Kbd> send · <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> newline · <Kbd>Esc</Kbd> stop
            </span>
            <div className="ml-auto">
              {running ? (
                <button onClick={onStop} aria-label="Stop" className="inline-flex items-center gap-1.5 rounded-md bg-bad/15 px-3 py-1.5 text-[12.5px] font-medium text-bad hover:bg-bad/25">
                  <Square size={12} fill="currentColor" /> Stop
                </button>
              ) : (
                <button onClick={submit} disabled={!text.trim() || disabled} aria-label="Send" className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-black hover:brightness-110 disabled:opacity-30">
                  Send <ArrowUp size={13} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
