/** Tiny pub/sub that carries runtime terminal output to the xterm component. */
export type TerminalMessage = { id: string; kind: "output" | "exit"; chunk?: string; code?: number | null };
type Listener = (m: TerminalMessage) => void;

const listeners = new Set<Listener>();

export const terminalBus = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  emit(m: TerminalMessage): void {
    for (const l of [...listeners]) l(m);
  },
};
