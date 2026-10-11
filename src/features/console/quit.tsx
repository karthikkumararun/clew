import { listen } from "@tauri-apps/api/event";
import { invoke } from "../../lib/ipc";
import { useConnections } from "../../connections/connectionsStore";
import { askChoice } from "./prompts";
import { allRuntimes } from "./runtime";

/**
 * Settle every console's open transaction before the app quits: Commit, Roll back or Cancel for
 * each. Resolves true when quitting may go on.
 */
export async function settleTransactionsBeforeQuit(): Promise<boolean> {
  for (const runtime of allRuntimes()) {
    const { txOpen, txPending } = runtime.store.getState();
    if (!txOpen) continue;
    const name =
      useConnections.getState().file.connections.find((c) => c.id === runtime.connectionId)?.name ??
      "a connection";
    const n = `${txPending} ${txPending === 1 ? "statement" : "statements"}`;
    const answer = await askChoice({
      title: "Uncommitted transaction",
      body: (
        <p>
          A console on <strong>{name}</strong> has an open transaction with {n}. Commit it, roll it
          back, or keep Clew open?
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "rollback", label: "Roll back" },
        { id: "commit", label: "Commit", variant: "primary" },
      ],
    });
    if (answer !== "commit" && answer !== "rollback") return false;
    if (!(await runtime.endTransaction(answer === "commit"))) return false;
  }
  return true;
}

let asking = false;

/** Listen for the backend holding a quit because a transaction is open. Returns a disposer. */
export function installQuitGuard(): () => void {
  let off: Promise<() => void> | null = null;
  try {
    off = listen("quit-requested", async () => {
      if (asking) return;
      asking = true;
      try {
        if (await settleTransactionsBeforeQuit()) await invoke("app_quit_confirmed");
      } finally {
        asking = false;
      }
    });
    // Outside the desktop app (tests, a plain browser) there is no event bridge: nothing to guard.
    off.catch(() => {});
  } catch {
    off = null;
  }
  return () => void off?.then((f) => f()).catch(() => {});
}
