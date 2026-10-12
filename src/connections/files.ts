import { invoke } from "@tauri-apps/api/core";
import { isTauri } from "../lib/ipc";

/** E2E builds (`VITE_CLEW_E2E=1`) answer native dialogs from the test's queue. Dead code otherwise. */
const SCRIPTED_DIALOGS = import.meta.env.VITE_CLEW_E2E === "1";
const scriptedAnswer = () => invoke<string | null>("e2e_dialog_next");

/** Native file picker. Returns `null` when cancelled or outside the app (browser dev/tests). */
export async function pickFile(opts: {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (!isTauri()) return null;
  if (SCRIPTED_DIALOGS) return scriptedAnswer();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: false, ...opts });
  return typeof picked === "string" ? picked : null;
}

/** Native save dialog. Returns `null` when cancelled or outside the app. */
export async function pickSavePath(opts: {
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (!isTauri()) return null;
  if (SCRIPTED_DIALOGS) return scriptedAnswer();
  const { save } = await import("@tauri-apps/plugin-dialog");
  return (await save(opts)) ?? null;
}

/** Native folder picker. Returns `null` when cancelled or outside the app. */
export async function pickFolder(opts: {
  title?: string;
  defaultPath?: string;
}): Promise<string | null> {
  if (!isTauri()) return null;
  if (SCRIPTED_DIALOGS) return scriptedAnswer();
  const { open } = await import("@tauri-apps/plugin-dialog");
  const picked = await open({ multiple: false, directory: true, ...opts });
  return typeof picked === "string" ? picked : null;
}
