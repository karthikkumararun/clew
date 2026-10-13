import { listen } from "@tauri-apps/api/event";
import { invoke } from "../../lib/ipc";
import { useConnections } from "../../connections/connectionsStore";
import { endTransaction, collectOpenTransactions } from "../sessions/actions";
import { plural } from "../sessions/format";
import { rowsOf, askOpenTransactions } from "../sessions/OpenTransactionsDialog";
import { openSessionsPanel } from "../sessions/panel";
import { tabSessionName } from "../sessions/tabs";
import { allRuntimes } from "./runtime";

/**
 * Settle every open transaction before the app quits: one dialog lists every session in a
 * transaction (spec: session-manager › Open transactions on quit) with Commit all, Roll back all,
 * Review in Sessions panel and Cancel. Resolves true when quitting may go on.
 */
export async function settleTransactionsBeforeQuit(): Promise<boolean> {
  const known = await collectOpenTransactions();
  const listed = new Set(known.map((s) => s.id));
  // Consoles whose transaction the backend list does not (yet) carry are still listed.
  const extra = allRuntimes().filter((runtime) => {
    const { txOpen, sessionId } = runtime.store.getState();
    return txOpen && !(sessionId && listed.has(sessionId));
  });
  const extraRows = extra.map((runtime) => ({
    id: runtime.sessionId ?? `console:${runtime.tabId}`,
    connection:
      useConnections.getState().file.connections.find((c) => c.id === runtime.connectionId)?.name ??
      "a connection",
    name: tabSessionName(runtime.tabId),
    duration: "0:00",
    statements: plural(runtime.store.getState().txPending, "statement"),
  }));
  const rows = [...rowsOf(known), ...extraRows];
  if (rows.length === 0) return true;
  const answer = await askOpenTransactions(rows, {
    title: "Uncommitted transactions",
    lead: `${plural(rows.length, "session has", "sessions have")} an open transaction. Commit or roll back before quitting?`,
  });
  if (answer === "review") {
    openSessionsPanel();
    return false;
  }
  if (answer !== "commit" && answer !== "rollback") return false;
  const commit = answer === "commit";
  for (const s of known) if (!(await endTransaction(s.id, commit))) return false;
  for (const runtime of extra) if (!(await runtime.endTransaction(commit))) return false;
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
