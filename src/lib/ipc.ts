import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "./appInfo";
import { getPlatform } from "./platform";
import { DEFAULT_SETTINGS } from "../stores/settingsDefaults";
import type { Settings } from "../stores/settingsDefaults";
import type { UiStateBackend } from "./uiState";

/** Shape of errors crossing IPC from the Rust `AppError`. */
export interface AppError {
  code: string;
  message: string;
  detail?: string;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function toAppError(e: unknown): AppError {
  if (e && typeof e === "object" && "code" in e && "message" in e) return e as AppError;
  return { code: "unknown", message: typeof e === "string" ? e : "Unexpected error" };
}

/** Typed invoke: rejects with an `AppError`. */
export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await tauriInvoke<T>(cmd, args);
  } catch (e) {
    throw toAppError(e);
  }
}

export interface AppPaths {
  dataDir: string;
  connectionsFile: string;
  connectionsFileDisplay: string;
  appVersion: string;
}

export async function appPaths(): Promise<AppPaths> {
  if (isTauri()) return invoke<AppPaths>("app_paths");
  // Plain-browser dev/test fallback (the real path comes from Rust inside the app).
  const dir = getPlatform() === "mac" ? "~/Library/Application Support/Clew" : "%APPDATA%\\Clew";
  const sep = getPlatform() === "mac" ? "/" : "\\";
  const file = `${dir}${sep}connections.json`;
  return {
    dataDir: dir,
    connectionsFile: file,
    connectionsFileDisplay: file,
    appVersion: APP_VERSION,
  };
}

export interface SettingsPayload {
  settings: Settings;
  notice: string | null;
}

export async function settingsGet(): Promise<SettingsPayload> {
  if (!isTauri()) return { settings: DEFAULT_SETTINGS, notice: null };
  return invoke<SettingsPayload>("settings_get");
}

export async function settingsSet(settings: Settings): Promise<Settings> {
  if (!isTauri()) return settings;
  return invoke<Settings>("settings_set", { settings });
}

/** UI-state backend backed by the `ui_state` table in clew.db. */
export const tauriUiStateBackend: UiStateBackend = {
  load: () => invoke<Record<string, string>>("ui_state_all"),
  save: (key, value) => {
    void invoke("ui_state_set", { key, value }).catch(() => {});
  },
};
