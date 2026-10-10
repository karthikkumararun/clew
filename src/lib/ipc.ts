import { invoke as tauriInvoke } from "@tauri-apps/api/core";
import { APP_VERSION } from "./appInfo";
import { getPlatform } from "./platform";

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
