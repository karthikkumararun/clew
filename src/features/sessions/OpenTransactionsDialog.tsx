import { create } from "zustand";
import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { useConnections } from "../../connections/connectionsStore";
import { inTransaction, openTransactions } from "../../stores/sessionsStore";
import { openFor, plural } from "./format";
import type { SessionMeta } from "./types";
import styles from "./Sessions.module.css";

export interface OpenTxRow {
  id: string;
  connection: string;
  name: string;
  /** How long the transaction has been open, `4:12`. */
  duration: string;
  statements: string;
}

export type OpenTxAnswer = "commit" | "rollback" | "review";

interface Request {
  title: string;
  lead: string;
  rows: OpenTxRow[];
  resolve: (answer: OpenTxAnswer | null) => void;
}

interface State {
  current: Request | null;
  queue: Request[];
}

const useRequests = create<State>(() => ({ current: null, queue: [] }));

/** One row per session in a transaction (connection, name, duration, statement count). */
export function rowsOf(sessions: SessionMeta[], now = Date.now()): OpenTxRow[] {
  const connections = useConnections.getState().file.connections;
  return openTransactions(sessions.filter(inTransaction)).map((s) => ({
    id: s.id,
    connection: connections.find((c) => c.id === s.connectionId)?.name ?? "a connection",
    name: s.name,
    duration: openFor(now - (s.txStartedAt ?? s.lastActivityAt)),
    statements: plural(s.txStatementCount, "statement"),
  }));
}

/**
 * One dialog for every session in a transaction, instead of one question per session (spec:
 * session-manager › Open transactions on quit). Resolves with the answer, or `null` for Cancel
 * and for dismissing the dialog.
 */
export function askOpenTransactions(
  rows: OpenTxRow[],
  opts: { title?: string; lead?: string } = {},
): Promise<OpenTxAnswer | null> {
  return new Promise((resolve) => {
    const request: Request = {
      title: opts.title ?? "Uncommitted transactions",
      lead:
        opts.lead ??
        `${plural(rows.length, "session has", "sessions have")} an open transaction. Commit or roll back before going on?`,
      rows,
      resolve,
    };
    useRequests.setState((s) =>
      s.current ? { queue: [...s.queue, request] } : { current: request },
    );
  });
}

function settle(answer: OpenTxAnswer | null) {
  const { current, queue } = useRequests.getState();
  current?.resolve(answer);
  useRequests.setState({ current: queue[0] ?? null, queue: queue.slice(1) });
}

/** Mounted once in the workspace. */
export function OpenTransactionsHost() {
  const current = useRequests((s) => s.current);
  if (!current) return null;
  return (
    <Dialog
      title={current.title}
      maxWidth={520}
      onClose={() => settle(null)}
      footer={
        <>
          <Button variant="default" onClick={() => settle(null)}>
            Cancel
          </Button>
          <Button variant="default" onClick={() => settle("review")}>
            Review in Sessions panel
          </Button>
          <Button variant="default" onClick={() => settle("rollback")}>
            Roll back all
          </Button>
          <Button variant="primary" onClick={() => settle("commit")}>
            Commit all
          </Button>
        </>
      }
    >
      <div className={styles.dialogBody}>
        <p>{current.lead}</p>
        <ul className={styles.txList} aria-label="Sessions in a transaction">
          {current.rows.map((r) => (
            <li key={r.id}>
              <span className={styles.txConn}>{r.connection}</span>
              <span>{r.name}</span>
              <span className={styles.txMeta}>
                open {r.duration} · {r.statements}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}

/** Test helper. */
export function clearOpenTransactionPrompts() {
  useRequests.setState({ current: null, queue: [] });
}
