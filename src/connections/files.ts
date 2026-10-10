import { isTauri } from "../lib/ipc";

/** Native file picker. Returns `null` when cancelled or outside the app (browser dev/tests). */
export async function pickFile(opts: {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
}): Promise<string | null> {
  if (!isTauri()) return null;
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
  const { save } = await import("@tauri-apps/plugin-dialog");
  return (await save(opts)) ?? null;
}
