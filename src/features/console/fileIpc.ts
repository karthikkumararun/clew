import { listen } from "@tauri-apps/api/event";
import { invoke, isTauri } from "../../lib/ipc";
import type { OpenedFile } from "../../lib/ipc/generated/OpenedFile";

export type { OpenedFile };

/** Let the user pick a SQL file (the dialog runs in Rust) and read it. */
export const fileOpenDialog = () => invoke<OpenedFile | null>("file_open_dialog");

/** Choose where to save `text`, starting in the connection's Scripts folder, and write it. */
export const fileSaveDialog = (connectionId: string | null, defaultName: string, text: string) =>
  invoke<string | null>("file_save_dialog", { connectionId, defaultName, text });

/** Read a file the user opened earlier, or one in a Scripts folder. */
export const fileRead = (path: string) => invoke<OpenedFile>("file_read", { path });

/** Overwrite a file the user opened earlier, or one in a Scripts folder. */
export const fileWrite = (path: string, text: string) =>
  invoke<number | null>("file_write", { path, text });

export const fileWatch = (path: string) => invoke<void>("file_watch", { path });
export const fileUnwatch = (path: string) => invoke<void>("file_unwatch", { path });

/** Called with the path of a watched file that changed on disk. */
export async function onFileChanged(handler: (path: string) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen<string>("file_changed", (e) => handler(e.payload));
}
