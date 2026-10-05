import { useEffect } from "react";
import { useApp } from "../stores/app";

const inEditable = (t: EventTarget | null) => t instanceof HTMLElement && (t.closest("input, textarea, select, .monaco-editor, .xterm") !== null || t.isContentEditable);

/** Global keyboard shortcuts. Ctrl or Cmd both work. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useApp.getState();
      const k = e.key.toLowerCase();
      if (mod && k === "k") return (e.preventDefault(), s.set({ dialog: s.dialog === "palette" ? null : "palette" }));
      if (mod && e.shiftKey && k === "p") return (e.preventDefault(), s.set({ dialog: "search" }));
      if (mod && k === "p") return (e.preventDefault(), s.set({ dialog: "quick-open" }));
      if (mod && k === "`") return (e.preventDefault(), s.set({ terminalOpen: !s.terminalOpen }));
      if (e.key === "Escape" && s.running && !s.dialog) return void s.cancel();
      if (mod && k === "z" && !inEditable(e.target)) {
        e.preventDefault();
        return void (e.shiftKey ? s.redo() : s.undo());
      }
      if (mod && k === "enter") {
        // Ctrl/Cmd+Enter sends from anywhere the composer is focused (handled by the textarea); focus it otherwise.
        document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message BetaCode"]')?.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
