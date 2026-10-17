import { invoke, isTauri } from "./ipc";

/** Open one of the few pages the app links to (key consoles, GitHub's device page). */
export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await invoke<void>("open_external", { url });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}
