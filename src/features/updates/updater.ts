import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";
import { isTauri } from "../../lib/ipc";
import { askChoice } from "../console/prompts";
import { settleTransactionsBeforeQuit } from "../console/quit";
import { CONSOLE_KIND, baseName, isConsoleDirty } from "../console/state";
import type { ConsoleState } from "../console/state";
import { useWorkspace } from "../../stores/workspaceStore";
import { useUpdates } from "./updateStore";

/** A found update, kept until it is installed or the app restarts. */
let pending: Update | null = null;

/** What the user sees when the package's signature does not verify. */
export const UNVERIFIED = "Update couldn't be verified";

/** The message for an error from the updater plugin. */
export function describeError(e: unknown, action: "check" | "install"): string {
  const text = e instanceof Error ? e.message : String(e);
  if (/signature|verif|minisign|pubkey/i.test(text)) return UNVERIFIED;
  return action === "check"
    ? `Couldn't check for updates: ${text}`
    : `Couldn't install the update: ${text}`;
}

/**
 * Ask the update server whether a newer version exists (spec: release-packaging › Opt-in
 * updates). Nothing is downloaded. `silent` leaves the dialog closed: the startup check only
 * records what it found.
 */
export async function checkForUpdates(opts: { silent?: boolean } = {}): Promise<void> {
  const store = useUpdates.getState();
  if (!isTauri()) {
    store.set({ kind: "error", message: "Updates are only available in the desktop app" });
    return;
  }
  store.set({ kind: "checking" });
  try {
    const update = await check();
    if (!update) {
      pending = null;
      store.set({ kind: "upToDate", checkedAt: Date.now() });
      return;
    }
    pending = update;
    store.set({
      kind: "available",
      version: update.version,
      notes: update.body ?? "",
      date: update.date,
    });
    if (!opts.silent) store.openDialog();
  } catch (e) {
    pending = null;
    store.set({ kind: "error", message: describeError(e, "check") });
  }
}

/** Consoles with changes that are not saved to their file. */
export function unsavedConsoles(): string[] {
  return useWorkspace
    .getState()
    .tabs.filter((t) => t.kind === CONSOLE_KIND && isConsoleDirty(t.state as ConsoleState))
    .map((t) => {
      const s = t.state as ConsoleState;
      return s.filePath ? baseName(s.filePath) : "console";
    });
}

/**
 * Whether the app may restart now (spec: release-packaging › Unsaved work on restart): nothing
 * unsaved, and any open transaction settled by the user.
 */
export async function readyToRestart(): Promise<boolean> {
  const unsaved = unsavedConsoles();
  if (unsaved.length > 0) {
    await askChoice({
      title: "Save your work before restarting",
      body: `${unsaved.length === 1 ? "A console has" : `${unsaved.length} consoles have`} unsaved changes (${[...new Set(unsaved)].join(", ")}). Save or discard ${unsaved.length === 1 ? "it" : "them"}, then install the update again.`,
      choices: [{ id: "back", label: "Back to work", variant: "primary" }],
    });
    return false;
  }
  return settleTransactionsBeforeQuit();
}

/**
 * Download and install the update, then restart. Asks first when work would be lost; a package
 * that does not verify is discarded and nothing restarts.
 */
export async function installAndRestart(): Promise<void> {
  const update = pending;
  const store = useUpdates.getState();
  if (!update) return;
  if (!(await readyToRestart())) return;
  store.set({ kind: "installing", percent: null });
  try {
    let total = 0;
    let done = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      if (event.event === "Progress") {
        done += event.data.chunkLength;
        useUpdates.getState().set({
          kind: "installing",
          percent: total > 0 ? Math.min(100, Math.round((done / total) * 100)) : null,
        });
      }
    });
  } catch (e) {
    store.set({ kind: "error", message: describeError(e, "install") });
    return;
  }
  pending = null;
  await relaunch();
}

/** Test helper. */
export function clearPendingUpdate() {
  pending = null;
}
