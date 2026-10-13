/** Typed bindings for the session commands (`src-tauri/src/commands/sessions.rs`). */
import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../../lib/ipc";
import type { SessionEvent, SessionMeta, TxAction } from "./types";

export type { SessionEvent, SessionMeta, SessionState, TxAction } from "./types";

/**
 * Receive every session change. The first event is a snapshot; later ones are upserts and
 * removals. Resolves once the backend has registered the channel.
 */
export async function sessionsSubscribe(onEvent: (event: SessionEvent) => void): Promise<void> {
  const channel = new Channel<SessionEvent>();
  channel.onmessage = onEvent;
  await invoke<void>("sessions_subscribe", { onEvent: channel });
}

export const sessionsList = () => invoke<SessionMeta[]>("sessions_list");

/** Name a session after its tab (the panel and queued tabs show it). */
export const sessionSetMeta = (args: { sessionId: string; name?: string; tabId?: string | null }) =>
  invoke<void>("session_set_meta", args);

export const sessionCommit = (sessionId: string) => invoke<void>("session_commit", { sessionId });
export const sessionRollback = (sessionId: string) =>
  invoke<void>("session_rollback", { sessionId });
export const sessionClose = (sessionId: string) => invoke<void>("session_close", { sessionId });
/**
 * Drop a session's server connection but keep its entry (state `disconnected`); it reconnects
 * silently on next use. Without `txAction` the backend does not refuse: ask first.
 */
export const sessionDisconnect = (sessionId: string, txAction?: TxAction) =>
  invoke<void>("session_disconnect", { sessionId, txAction });
export const sessionCancel = (sessionId: string) => invoke<void>("query_cancel", { sessionId });

export const sessionCloseAll = (connectionId: string, txAction?: TxAction) =>
  invoke<void>("session_close_all", { connectionId, txAction });

/** Close every session and the SSH tunnel; the connection stays listed as disconnected. */
export const connectionDeactivate = (connectionId: string, txAction?: TxAction) =>
  invoke<void>("connection_deactivate", { connectionId, txAction });

export const sessionSetIsolation = (sessionId: string, level: string) =>
  invoke<void>("session_set_isolation", { sessionId, level });

/** Rebind a tab to an existing session of the same connection. */
export const sessionAttach = (sessionId: string, tabId: string) =>
  invoke<void>("session_attach", { sessionId, tabId });

/** A tab stops using a session; the session closes when no tab is left. Resolves with whether it closed. */
export const sessionDetach = (sessionId: string, tabId: string) =>
  invoke<boolean>("session_detach", { sessionId, tabId });

/** Sessions that have an open transaction, for the quit dialog. */
export const sessionsOpenTransactions = () => invoke<SessionMeta[]>("sessions_open_transactions");
