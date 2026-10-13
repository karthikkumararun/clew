import { sessionOpen } from "../../lib/ipc/drivers";
import { useConnections } from "../../connections/connectionsStore";
import { useLayout } from "../../stores/layoutStore";
import { useNotices } from "../../stores/noticesStore";
import { inTransaction, openTransactions, useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { askChoice } from "../console/prompts";
import { allRuntimes, peekRuntime } from "../console/runtime";
import {
  connectionDeactivate,
  sessionAttach,
  sessionCancel,
  sessionDisconnect,
  sessionCloseAll,
  sessionCommit,
  sessionDetach,
  sessionRollback,
  sessionSetIsolation,
  sessionsOpenTransactions,
} from "./api";
import { askOpenTransactions, rowsOf } from "./OpenTransactionsDialog";
import type { OpenTxAnswer } from "./OpenTransactionsDialog";
import { tabsOfSession } from "./tabs";
import type { SessionMeta, TxAction } from "./types";

const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);

const fail = (what: string, e: unknown) => useNotices.getState().push(`${what}: ${messageOf(e)}`);

/** The console that runs on a session, when this window has one. */
const runtimeOf = (sessionId: string) => allRuntimes().find((r) => r.sessionId === sessionId);

/** Commit or roll back a session's transaction. A console ends its own so its Output log shows it. */
export async function endTransaction(sessionId: string, commit: boolean): Promise<boolean> {
  try {
    const runtime = runtimeOf(sessionId);
    if (runtime && runtime.store.getState().txOpen) return await runtime.endTransaction(commit);
    await (commit ? sessionCommit(sessionId) : sessionRollback(sessionId));
    return true;
  } catch (e) {
    fail(commit ? "Couldn't commit" : "Couldn't roll back", e);
    return false;
  }
}

/** Cancel the statement a session is running. */
export async function cancelSession(sessionId: string): Promise<void> {
  try {
    await sessionCancel(sessionId);
  } catch {
    /* nothing to cancel any more */
  }
}

/** Close a session; its tab stays open and reconnects on next use. Asks first with a transaction. */
export async function closeSession(session: SessionMeta): Promise<boolean> {
  let txAction: TxAction | undefined;
  if (inTransaction(session)) {
    const answer = await askChoice({
      title: "Uncommitted transaction",
      body: (
        <p>
          <strong>{session.name}</strong> has an open transaction with {session.txStatementCount}{" "}
          {session.txStatementCount === 1 ? "statement" : "statements"}. Commit it, roll it back, or
          keep the session open?
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "rollback", label: "Roll back" },
        { id: "commit", label: "Commit", variant: "primary" },
      ],
    });
    if (answer !== "commit" && answer !== "rollback") return false;
    txAction = answer;
  }
  try {
    await sessionDisconnect(session.id, txAction);
    return true;
  } catch (e) {
    fail("Couldn't close the session", e);
    return false;
  }
}

/** Sessions of one connection that hold a transaction. */
const txOf = (connectionId: string) =>
  openTransactions(
    Object.values(useSessions.getState().sessions).filter((s) => s.connectionId === connectionId),
  );

/** Ask about open transactions, then resolve what to do with them (`undefined` = none open). */
async function settleOpen(
  sessions: SessionMeta[],
  title: string,
  connectionId?: string,
): Promise<{ txAction?: TxAction } | null> {
  if (sessions.length === 0) return {};
  const answer = await askOpenTransactions(rowsOf(sessions), { title });
  return resolveAnswer(answer, connectionId);
}

function resolveAnswer(
  answer: OpenTxAnswer | null,
  connectionId?: string,
): { txAction?: TxAction } | null {
  if (answer === "review") {
    useLayout.getState().openBottomPanel();
    if (connectionId) useSessions.getState().select({ kind: "connection", id: connectionId });
    return null;
  }
  return answer === null ? null : { txAction: answer };
}

/** Close every session of a connection (spec: session-manager › Session actions). */
export async function closeAllSessions(connectionId: string): Promise<boolean> {
  const settled = await settleOpen(txOf(connectionId), "Close all sessions", connectionId);
  if (!settled) return false;
  try {
    await sessionCloseAll(connectionId, settled.txAction);
    return true;
  } catch (e) {
    fail("Couldn't close the sessions", e);
    return false;
  }
}

/** Close every session and the tunnel; the connection stays in the explorer as disconnected. */
export async function deactivateConnection(connectionId: string): Promise<boolean> {
  const settled = await settleOpen(txOf(connectionId), "Deactivate connection", connectionId);
  if (!settled) return false;
  try {
    await connectionDeactivate(connectionId, settled.txAction);
    useConnections.setState((s) => {
      const connected = { ...s.connected };
      delete connected[connectionId];
      return { connected };
    });
    useSessions.getState().markDeactivated(connectionId, true);
    return true;
  } catch (e) {
    fail("Couldn't deactivate the connection", e);
    return false;
  }
}

/** Roll back several sessions, e.g. every idle one. Resolves with how many rolled back. */
export async function rollBackSessions(sessions: SessionMeta[]): Promise<number> {
  let done = 0;
  for (const s of sessions) if (await endTransaction(s.id, false)) done += 1;
  return done;
}

/** The sessions flagged as idle in a transaction, oldest first. */
export const idleSessions = (): SessionMeta[] => {
  const { sessions, idle } = useSessions.getState();
  return openTransactions(Object.values(sessions).filter((s) => idle[s.id]));
};

/** Roll back all idle: lists them first and rolls back on Confirm (spec: Idle-in-transaction › Roll back all idle). */
export async function rollBackAllIdle(): Promise<void> {
  const flagged = idleSessions();
  if (flagged.length === 0) return;
  const rows = rowsOf(flagged);
  const answer = await askChoice({
    title: "Roll back all idle",
    body: (
      <>
        <p>
          {flagged.length === 1 ? "This session has" : "These sessions have"} been idle in a
          transaction. Roll {flagged.length === 1 ? "it" : "them"} back?
        </p>
        <ul aria-label="Idle sessions">
          {rows.map((r) => (
            <li key={r.id}>
              {r.connection} · {r.name} · open {r.duration} · {r.statements}
            </li>
          ))}
        </ul>
      </>
    ),
    choices: [
      { id: "cancel", label: "Cancel" },
      { id: "confirm", label: "Confirm", variant: "primary" },
    ],
  });
  if (answer === "confirm") await rollBackSessions(flagged);
}

/** Bring the tab of a session to the front. */
export function goToTab(session: SessionMeta): void {
  const tabs = useWorkspace.getState().tabs;
  const tab =
    tabs.find((t) => t.id === session.tabId) ?? tabsOfSession(session.id, tabs)[0] ?? undefined;
  if (tab) useWorkspace.getState().activateTab(tab.id);
}

/** Select a session in the panel, opening the panel. */
export function showSession(session: SessionMeta): void {
  useSessions.getState().select({ kind: "session", id: session.id });
  useLayout.getState().openBottomPanel();
}

/**
 * Change a session's isolation level (spec: sql-console › Transaction isolation level). Inside an
 * open transaction it asks to commit or roll back first. Resolves false when nothing changed.
 */
export async function changeIsolation(
  target: { id: string; name: string },
  inTx: boolean,
  level: string,
): Promise<boolean> {
  if (inTx) {
    const answer = await askChoice({
      title: "Change isolation level",
      body: (
        <p>
          <strong>{target.name}</strong> has an open transaction. Commit it or roll it back before
          switching to <strong>{level}</strong>?
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "rollback", label: "Roll back" },
        { id: "commit", label: "Commit", variant: "primary" },
      ],
    });
    if (answer !== "commit" && answer !== "rollback") return false;
    if (!(await endTransaction(target.id, answer === "commit"))) return false;
  }
  try {
    await sessionSetIsolation(target.id, level);
    return true;
  } catch (e) {
    fail("Couldn't change the isolation level", e);
    return false;
  }
}

/** Where a tab can run: its own session, a session of the connection, or a fresh one. */
export type AttachTarget = { kind: "own" } | { kind: "new" } | { kind: "session"; id: string };

/** Rebind a console tab to another session (spec: session-manager › Switch session). */
export async function attachTab(tabId: string, connectionId: string, target: AttachTarget) {
  const runtime = peekRuntime(tabId);
  if (runtime?.busy) {
    useNotices
      .getState()
      .push("Wait for the running statement to finish before switching sessions.");
    return false;
  }
  try {
    const previous = runtime?.store.getState().sessionId ?? null;
    let sessionId: string;
    if (target.kind === "session") sessionId = target.id;
    else sessionId = (await sessionOpen(connectionId)).sessionId;
    if (sessionId === previous) return true;
    await sessionAttach(sessionId, tabId);
    // the old session closes when this was its last tab
    if (previous) await sessionDetach(previous, tabId);
    const meta = useSessions.getState().sessions[sessionId];
    runtime?.rebind(sessionId, {
      open: meta?.state === "in_transaction",
      statements: meta?.txStatementCount ?? 0,
    });
    useWorkspace.getState().updateTabState<{ sessionId?: string }>(tabId, { sessionId });
    return true;
  } catch (e) {
    fail("Couldn't switch the session", e);
    return false;
  }
}

/** Authoritative list for the quit dialog: the backend's, else what the store knows. */
export async function collectOpenTransactions(): Promise<SessionMeta[]> {
  try {
    const listed = await sessionsOpenTransactions();
    if (Array.isArray(listed)) return openTransactions(listed);
  } catch {
    /* no backend (tests, a plain browser): use the store */
  }
  return openTransactions(Object.values(useSessions.getState().sessions));
}
