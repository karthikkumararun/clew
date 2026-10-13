import { useState } from "react";
import { Button, IconButton } from "../../components/Button";
import { Input } from "../../components/Input";
import { Check, ChevronDown, Close } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { useLayout } from "../../stores/layoutStore";
import { useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import {
  cancelSession,
  closeAllSessions,
  closeSession,
  deactivateConnection,
  endTransaction,
  rollBackAllIdle,
} from "./actions";
import { actionsOf } from "./format";
import { buildNodes } from "./model";
import { ConnectionDetails, SessionDetails } from "./SessionDetails";
import { SessionTree } from "./SessionTree";
import { SwitchSessionMenu } from "./SwitchSessionMenu";
import { tabTitle } from "./tabs";
import type { SessionMeta } from "./types";
import styles from "./Sessions.module.css";

/** Rollback glyph from the canvas (Sessions.dc.html › Roll back). */
function RollbackIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M5 6L2.5 8.5 5 11M3 8.5h6a4 4 0 0 1 0 5H6" />
    </svg>
  );
}

function StopIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="4" y="4" width="8" height="8" rx="1" />
    </svg>
  );
}

/**
 * The Sessions panel (spec: session-manager › Sessions panel): a toolbar, every connection with
 * its sessions on the left and the selected session's details on the right.
 */
export function SessionsPanel() {
  const connections = useConnections((s) => s.file.connections);
  const connected = useConnections((s) => s.connected);
  const sessions = useSessions((s) => s.sessions);
  const order = useSessions((s) => s.order);
  const selection = useSessions((s) => s.selection);
  const filter = useSessions((s) => s.filter);
  const deactivated = useSessions((s) => s.deactivated);
  const idle = useSessions((s) => s.idle);
  const setFilter = useSessions((s) => s.setFilter);
  const close = useLayout((s) => s.closeBottomPanel);
  const [menu, setMenu] = useState<{
    session: SessionMeta;
    anchor: HTMLElement;
    tabId?: string;
  } | null>(null);
  // Rebuild the tab names when tabs change.
  useWorkspace((s) => s.tabs);

  const all = order.map((id) => sessions[id]).filter(Boolean);
  const nodes = buildNodes(connections, all, connected, deactivated, filter);
  const session = selection?.kind === "session" ? sessions[selection.id] : undefined;
  const connection = connections.find(
    (c) => c.id === (selection?.kind === "connection" ? selection.id : session?.connectionId),
  );
  const can = actionsOf(session);
  const idleCount = Object.keys(idle).length;

  return (
    <div className={styles.panel} data-testid="sessions-panel">
      <div className={styles.toolbar} role="toolbar" aria-label="Sessions actions">
        <span className={styles.heading}>SESSIONS</span>
        <IconButton
          aria-label="Cancel running statement"
          disabled={!can.cancel}
          onClick={() => session && void cancelSession(session.id)}
        >
          <StopIcon />
        </IconButton>
        <IconButton
          aria-label="Commit"
          disabled={!can.commit}
          onClick={() => session && void endTransaction(session.id, true)}
        >
          <Check size={14} />
        </IconButton>
        <IconButton
          aria-label="Roll back"
          disabled={!can.rollback}
          onClick={() => session && void endTransaction(session.id, false)}
        >
          <RollbackIcon />
        </IconButton>
        <div className={styles.divider} />
        <IconButton
          aria-label="Close session"
          disabled={!can.close}
          onClick={() => session && void closeSession(session)}
        >
          <Close size={14} strokeWidth={1.6} />
        </IconButton>
        <Button
          disabled={!connection}
          onClick={() => connection && void closeAllSessions(connection.id)}
        >
          Close all sessions
        </Button>
        <Button
          disabled={!connection || !(connection.id in connected)}
          onClick={() => connection && void deactivateConnection(connection.id)}
        >
          Deactivate connection
        </Button>
        {idleCount > 0 ? (
          <Button onClick={() => void rollBackAllIdle()}>Roll back all idle ({idleCount})</Button>
        ) : null}
        <div className={styles.grow} />
        <label htmlFor="sessions-filter" className="sr-only">
          Filter sessions
        </label>
        <Input
          id="sessions-filter"
          className={styles.filter}
          placeholder="Filter sessions…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <IconButton aria-label="Hide panel" onClick={close}>
          <ChevronDown size={14} />
        </IconButton>
      </div>
      <div className={styles.body}>
        <SessionTree
          nodes={nodes}
          tabName={(tabId) => {
            const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
            return tab ? tabTitle(tab) : tabId;
          }}
          onAttachMenu={(s, anchor, tabId) => setMenu({ session: s, anchor, tabId })}
        />
        {session ? (
          <SessionDetails
            session={session}
            onAttachMenu={(s, anchor) => setMenu({ session: s, anchor })}
          />
        ) : selection?.kind === "connection" && connection ? (
          <ConnectionDetails connection={connection} />
        ) : (
          <div className={styles.details}>
            <p className={styles.empty} style={{ padding: 0 }}>
              Select a session to see its details.
            </p>
          </div>
        )}
      </div>
      {menu ? (
        <SwitchSessionMenu
          session={menu.session}
          tabId={menu.tabId}
          anchor={menu.anchor}
          onClose={() => {
            // the menu returns focus to what opened it
            const opener = menu.anchor;
            setMenu(null);
            if (opener.isConnected) opener.focus();
          }}
        />
      ) : null}
    </div>
  );
}
