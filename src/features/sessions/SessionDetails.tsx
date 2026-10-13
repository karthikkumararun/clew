import { useRef, useState } from "react";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { Button } from "../../components/Button";
import { Menu } from "../../components/Menu";
import { ChevronDown, Warning } from "../../components/icons";
import type { Connection } from "../../connections/api";
import { useConnections } from "../../connections/connectionsStore";
import { useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import {
  cancelSession,
  changeIsolation,
  closeAllSessions,
  closeSession,
  deactivateConnection,
  endTransaction,
  goToTab,
} from "./actions";
import {
  actionsOf,
  ago,
  breakdownText,
  connectionSummary,
  openFor,
  plural,
  STATE_LABEL,
  stateColor,
  timeOfDay,
} from "./format";
import { tabsOfSession } from "./tabs";
import type { SessionMeta } from "./types";
import styles from "./Sessions.module.css";

const BACKEND_LABEL: Record<string, string> = {
  postgres: "Backend PID",
  mysql: "Connection ID",
  mariadb: "Connection ID",
};

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function databaseOf(connection: Connection, session: SessionMeta): string | undefined {
  const tab = tabsOfSession(session.id, useWorkspace.getState().tabs)[0];
  const fromTab = (tab?.state as { database?: string } | null)?.database;
  if (fromTab) return fromTab;
  const s = connection.settings;
  return "database" in s && typeof s.database === "string" && s.database ? s.database : undefined;
}

/** The isolation selector: a level menu, or the reason there is none. */
function IsolationRow({ session }: { session: SessionMeta }) {
  const [open, setOpen] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    opener.current?.focus();
  };
  if (session.supportedIsolation.length === 0) {
    return (
      <Fact label="Isolation level">
        <span className={styles.hint} style={{ marginLeft: 0 }}>
          {session.isolationNote ?? "This database has no transaction isolation levels."}
        </span>
      </Fact>
    );
  }
  const inTx = session.state === "in_transaction" || session.state === "aborted";
  return (
    <div>
      <dt style={{ paddingTop: 4 }}>Isolation level</dt>
      <dd>
        <button
          ref={opener}
          type="button"
          className={styles.levelButton}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-label={`Isolation level: ${session.isolation ?? "server default"}`}
          disabled={session.state === "running" || session.state === "disconnected"}
          onClick={() => setOpen((o) => !o)}
        >
          {session.isolation ?? "Server default"}
          <ChevronDown size={12} />
        </button>
        <span className={styles.hint}>
          {inTx ? "applies to the next transaction" : "applies immediately"}
        </span>
        {open ? (
          <AnchoredMenu anchor={opener}>
            <Menu
              aria-label="Isolation level"
              items={session.supportedIsolation.map((level) => ({
                id: level,
                label: level,
                hint: session.isolation === level ? "✓" : undefined,
              }))}
              onClose={close}
              onSelect={(level) => {
                close();
                void changeIsolation(session, inTx, level);
              }}
            />
          </AnchoredMenu>
        ) : null}
      </dd>
    </div>
  );
}

/** The selected session: identifiers, timings, the open transaction and what can be done to it. */
export function SessionDetails({
  session,
  onAttachMenu,
}: {
  session: SessionMeta;
  onAttachMenu: (session: SessionMeta, anchor: HTMLElement) => void;
}) {
  const connection = useConnections((s) =>
    s.file.connections.find((c) => c.id === session.connectionId),
  );
  const info = useConnections((s) => s.connected[session.connectionId]);
  const flagged = useSessions((s) => Boolean(s.idle[session.id]));
  const now = useSessions((s) => s.now);
  const attach = useRef<HTMLButtonElement>(null);
  const can = actionsOf(session);
  const production = connection?.environment === "production";
  const inTx = session.state === "in_transaction" || session.state === "aborted";
  const hasTab = tabsOfSession(session.id).length > 0;
  const database = connection ? databaseOf(connection, session) : undefined;
  const server = info ? `${info.server.product} ${info.server.version}` : undefined;
  const last = [...session.txStatements].slice(-3).reverse();
  const txMinutes = Math.max(
    0,
    Math.floor((now - (session.txStartedAt ?? session.lastActivityAt)) / 60_000),
  );

  return (
    <div className={styles.details} aria-label="Session details" role="region">
      {flagged ? (
        <div className={styles.banner} role="alert" data-production={production}>
          <Warning size={14} />
          <span>
            <b>
              Open for {plural(txMinutes, "minute")}
              {production ? " on Production" : ""}.
            </b>{" "}
            An open transaction can block other writers and keep old row versions alive. Commit or
            roll back when you are done.
          </span>
        </div>
      ) : null}
      <div className={styles.titleRow}>
        <span className={styles.title}>{session.name}</span>
        <span
          className={styles.stateBadge}
          style={{ color: stateColor(session.state, production) }}
        >
          <span
            className={styles.stateDot}
            style={{ background: stateColor(session.state, production) }}
            aria-hidden="true"
          />
          {STATE_LABEL[session.state]}
        </span>
      </div>
      <dl className={styles.facts}>
        <Fact label="Connection">
          {connection?.name ?? "unknown"}
          {database ? ` · ${database}` : ""}
        </Fact>
        <Fact label="Server">
          {server ?? "not connected"}
          {info?.transport ? ` · ${info.transport}` : ""}
        </Fact>
        {session.backendId ? (
          <Fact label={BACKEND_LABEL[connection?.driver ?? ""] ?? "Backend ID"}>
            {session.backendId}
          </Fact>
        ) : null}
        <Fact label="Started">{timeOfDay(session.startedAt)}</Fact>
        <Fact label="Last activity">
          {timeOfDay(session.lastActivityAt)} ({ago(now - session.lastActivityAt)} ago)
        </Fact>
        {inTx ? (
          <Fact label="Statements in tx">
            {session.txStatementCount}
            {breakdownText(session.txBreakdown) ? ` (${breakdownText(session.txBreakdown)})` : ""}
          </Fact>
        ) : null}
        {inTx && session.txStartedAt ? (
          <Fact label="Transaction open">{openFor(now - session.txStartedAt)}</Fact>
        ) : null}
        <IsolationRow session={session} />
        <Fact label="Mode">{session.readOnly ? "Read-only" : "Read-write"}</Fact>
        {session.waitingFor ? <Fact label="Queue">Waiting for {session.waitingFor}</Fact> : null}
      </dl>
      {inTx && last.length > 0 ? (
        <div>
          <div className={styles.sectionLabel}>LAST STATEMENTS IN THIS TRANSACTION</div>
          <pre className={styles.statements} aria-label="Last statements">
            {last.map((st, i) => (
              <div key={`${st.at}-${i}`}>
                <span className={styles.statementTime}>{timeOfDay(st.at)}</span>
                {st.text.replace(/\s+/g, " ").trim()}
              </div>
            ))}
          </pre>
        </div>
      ) : null}
      <div className={styles.actions}>
        {can.cancel ? (
          <Button onClick={() => void cancelSession(session.id)}>Cancel statement</Button>
        ) : null}
        <Button
          className={styles.commit}
          disabled={!can.commit}
          onClick={() => void endTransaction(session.id, true)}
        >
          Commit
        </Button>
        <Button disabled={!can.rollback} onClick={() => void endTransaction(session.id, false)}>
          Roll back
        </Button>
        <Button variant="ghost" disabled={!hasTab} onClick={() => goToTab(session)}>
          Go to tab
        </Button>
        <Button
          ref={attach}
          variant="ghost"
          disabled={!hasTab || session.state === "running"}
          aria-haspopup="menu"
          onClick={() => attach.current && onAttachMenu(session, attach.current)}
        >
          Attach to…
        </Button>
        <Button variant="ghost" onClick={() => void closeSession(session)}>
          Close session
        </Button>
      </div>
    </div>
  );
}

/** A connection row selected: its summary and the actions that apply to all its sessions. */
export function ConnectionDetails({ connection }: { connection: Connection }) {
  const info = useConnections((s) => s.connected[connection.id]);
  const all = useSessions((s) => s.sessions);
  const sessions = Object.values(all).filter((x) => x.connectionId === connection.id);
  const live = Boolean(info);
  return (
    <div className={styles.details} aria-label="Connection details" role="region">
      <div className={styles.titleRow}>
        <span className={styles.title}>{connection.name}</span>
        <span className={styles.stateBadge}>
          {connectionSummary(sessions, !live && sessions.length === 0)}
        </span>
      </div>
      <dl className={styles.facts}>
        <Fact label="Server">
          {info ? `${info.server.product} ${info.server.version}` : "disconnected"}
          {info?.transport ? ` · ${info.transport}` : ""}
        </Fact>
        <Fact label="Environment">{connection.environment}</Fact>
      </dl>
      <div className={styles.actions}>
        <Button
          disabled={sessions.length === 0}
          onClick={() => void closeAllSessions(connection.id)}
        >
          Close all sessions
        </Button>
        <Button disabled={!live} onClick={() => void deactivateConnection(connection.id)}>
          Deactivate connection
        </Button>
      </div>
    </div>
  );
}
