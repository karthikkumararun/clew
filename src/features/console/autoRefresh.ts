import { isWrite } from "./explain";

/** The choices of the toolbar's auto-refresh menu, in milliseconds (0 = Off). */
export const REFRESH_PRESETS: { ms: number; label: string }[] = [
  { ms: 0, label: "Off" },
  { ms: 5_000, label: "Every 5 seconds" },
  { ms: 10_000, label: "Every 10 seconds" },
  { ms: 30_000, label: "Every 30 seconds" },
  { ms: 60_000, label: "Every minute" },
];

/** What the toolbar shows for the current setting: `Every 10 s`, `Every 2 min`. */
export function refreshLabel(ms: number): string {
  if (ms <= 0) return "Off";
  if (ms % 60_000 === 0) return ms === 60_000 ? "Every min" : `Every ${ms / 60_000} min`;
  return `Every ${ms / 1000} s`;
}

/** Only read statements may refresh themselves (spec: sql-console › Not for writes). */
export function canAutoRefresh(sql: string): { ok: true } | { ok: false; reason: string } {
  return isWrite(sql)
    ? { ok: false, reason: "Only read statements can refresh automatically" }
    : { ok: true };
}

export type PauseReason = "pending" | "hidden" | "background";

/** Why a refresh that is due should be skipped now, if it should (spec: sql-console › Pending changes). */
export function pauseReason(s: {
  pendingChanges: number;
  tabVisible: boolean;
  windowFocused: boolean;
}): PauseReason | null {
  if (s.pendingChanges > 0) return "pending";
  if (!s.tabVisible) return "hidden";
  if (!s.windowFocused) return "background";
  return null;
}

export const pauseText = (r: PauseReason): string =>
  r === "pending"
    ? "Paused: pending changes"
    : r === "hidden"
      ? "Paused: tab not visible"
      : "Paused: window in the background";
