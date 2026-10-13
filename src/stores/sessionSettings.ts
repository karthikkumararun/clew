import { create } from "zustand";
import { clamp } from "../lib/clamp";
import { getUiBool, getUiNumber, setUiState } from "../lib/uiState";
import { DEFAULT_SESSION_SETTINGS } from "./settingsDefaults";
import type { SessionSettings } from "./settingsDefaults";

export { DEFAULT_SESSION_SETTINGS };
export type { SessionSettings };

export const IDLE_MINUTES_RANGE = { min: 1, max: 240 } as const;

const KEYS = {
  idleMinutes: "sessions.idleMinutes",
  production: "sessions.idleMinutes.production",
  local: "sessions.idleMinutes.local",
  notify: "sessions.notify",
} as const;

function read(): SessionSettings {
  const minutes = (key: string, fallback: number) =>
    clamp(Math.round(getUiNumber(key, fallback)), IDLE_MINUTES_RANGE.min, IDLE_MINUTES_RANGE.max);
  return {
    idleMinutes: minutes(KEYS.idleMinutes, DEFAULT_SESSION_SETTINGS.idleMinutes),
    production: minutes(KEYS.production, DEFAULT_SESSION_SETTINGS.production),
    local: minutes(KEYS.local, DEFAULT_SESSION_SETTINGS.local),
    notify: getUiBool(KEYS.notify, DEFAULT_SESSION_SETTINGS.notify),
  };
}

interface SessionSettingsState {
  settings: SessionSettings;
  set: (patch: Partial<SessionSettings>) => void;
  /** Re-read after the UI-state cache has been hydrated at startup. */
  rehydrate: () => void;
}

/**
 * The thresholds persist in the UI-state store: the app's settings file is owned by the Rust
 * side and drops fields it does not know.
 */
export const useSessionSettings = create<SessionSettingsState>((set, get) => ({
  settings: read(),
  set: (patch) => {
    const next = { ...get().settings, ...patch };
    const minutes = (n: number) =>
      clamp(Math.round(Number(n) || 0), IDLE_MINUTES_RANGE.min, IDLE_MINUTES_RANGE.max);
    next.idleMinutes = minutes(next.idleMinutes);
    next.production = minutes(next.production);
    next.local = minutes(next.local);
    set({ settings: next });
    setUiState(KEYS.idleMinutes, String(next.idleMinutes));
    setUiState(KEYS.production, String(next.production));
    setUiState(KEYS.local, String(next.local));
    setUiState(KEYS.notify, String(next.notify));
  },
  rehydrate: () => set({ settings: read() }),
}));

/** Idle threshold in ms for a connection's environment. */
export function idleThresholdMs(
  environment: string | undefined,
  s: SessionSettings = useSessionSettings.getState().settings,
): number {
  const minutes =
    environment === "production"
      ? s.production
      : environment === "local" || environment === "development"
        ? s.local
        : s.idleMinutes;
  return minutes * 60_000;
}

/** Local and development connections show the badge only. */
export function notifiesFor(
  environment: string | undefined,
  s: SessionSettings = useSessionSettings.getState().settings,
): boolean {
  return s.notify && environment !== "local" && environment !== "development";
}
