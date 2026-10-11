import type { ServerEvent } from "./types";

export type SetupEvent = Extract<ServerEvent, { scope: "setup" }>;
type Listener = (e: SetupEvent) => void;
const listeners = new Set<Listener>();

/** Carries model-download progress from the runtime to the setup screen. */
export const setupBus = {
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  emit(e: SetupEvent): void {
    for (const l of [...listeners]) l(e);
  },
};
