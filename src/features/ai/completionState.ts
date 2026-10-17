import { create } from "zustand";

/** Errors in a row after which completions pause, and for how long (spec: ai-inline-completion). */
export const ERROR_LIMIT = 3;
export const PAUSE_MS = 60_000;

interface CompletionState {
  failures: number;
  /** When completions may resume (ms since the epoch), while paused. */
  pausedUntil: number | null;
  /** The last request failed in a way worth showing. */
  recordFailure: (now?: number) => void;
  recordSuccess: () => void;
}

export const useCompletionState = create<CompletionState>((set, get) => ({
  failures: 0,
  pausedUntil: null,
  recordFailure: (now = Date.now()) => {
    const failures = get().failures + 1;
    set(failures >= ERROR_LIMIT ? { failures: 0, pausedUntil: now + PAUSE_MS } : { failures });
  },
  recordSuccess: () => set({ failures: 0 }),
}));

/** Whether completions are paused after repeated provider errors. */
export function completionsPaused(now = Date.now()): boolean {
  const until = useCompletionState.getState().pausedUntil;
  if (until === null) return false;
  if (now >= until) {
    useCompletionState.setState({ pausedUntil: null });
    return false;
  }
  return true;
}
