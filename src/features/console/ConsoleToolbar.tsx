import { useState } from "react";
import { useStore } from "zustand";
import { Menu } from "../../components/Menu";
import { ChevronDown, Lines, Play } from "../../components/icons";
import { formatShortcut } from "../../lib/platform";
import { useConnections } from "../../connections/connectionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { ReadOnlyBadge } from "../safety/ReadOnlyBadge";
import { supportsTransactions } from "./editor/dialects";
import {
  cancelActive,
  endActiveTransaction,
  explainActive,
  runActive,
  setTxMode,
} from "./commands";
import { formatElapsed, useElapsed } from "./ResultsPanel";
import { getRuntime } from "./runtime";
import { CONSOLE_KIND } from "./state";
import type { ConsoleState } from "./state";
import styles from "./Console.module.css";

/** Run / Cancel (and later Explain and the transaction controls) for the active console. */
export function ConsoleToolbar() {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  if (!tab || tab.kind !== CONSOLE_KIND) return null;
  return <Controls tabId={tab.id} connectionId={(tab.state as ConsoleState).connectionId} />;
}

function Controls({ tabId, connectionId }: { tabId: string; connectionId: string }) {
  const runtime = getRuntime(tabId, connectionId);
  const busy = useStore(runtime.store, (s) => s.busy);
  const startedAt = useStore(runtime.store, (s) => s.startedAt);
  const elapsed = useElapsed(busy ? startedAt : null);
  const [explainMenu, setExplainMenu] = useState(false);
  const [txMenu, setTxMenu] = useState(false);
  const txMode = useWorkspace(
    (s) =>
      (s.tabs.find((t) => t.id === tabId)?.state as ConsoleState | undefined)?.txMode ?? "auto",
  );
  const txOpen = useStore(runtime.store, (s) => s.txOpen);
  const txPending = useStore(runtime.store, (s) => s.txPending);
  const readOnly = useStore(runtime.store, (s) => s.readOnly);
  const driverId = useConnections(
    (s) => s.file.connections.find((c) => c.id === connectionId)?.driver ?? "",
  );
  const transactional = supportsTransactions(driverId);
  const connection = useConnections((s) => s.file.connections.find((c) => c.id === connectionId));
  return (
    <>
      {connection ? (
        <ReadOnlyBadge
          connectionName={connection.name}
          environment={connection.environment}
          readOnly={readOnly}
          onChange={(ro) => void runtime.setReadOnly(ro)}
        />
      ) : null}
      {busy ? (
        <button
          type="button"
          className={`${styles.tbButton} ${styles.cancelButton}`}
          onClick={() => void cancelActive()}
        >
          <span className={styles.spinner} aria-hidden="true" />
          Cancel
          <span className={styles.kbd}>{formatElapsed(elapsed)}</span>
        </button>
      ) : (
        <button
          type="button"
          className={`${styles.tbButton} ${styles.runButton}`}
          onClick={() => void runActive("current")}
        >
          <Play size={12} />
          Run
          <span className={styles.kbd}>{formatShortcut("Mod+Enter")}</span>
        </button>
      )}
      <span className={styles.splitButton}>
        <button
          type="button"
          className={styles.tbButton}
          disabled={busy}
          onClick={() => void explainActive(false)}
        >
          <Lines size={12} />
          Explain
        </button>
        <button
          type="button"
          className={`${styles.tbButton} ${styles.splitChevron}`}
          aria-label="More explain options"
          aria-haspopup="menu"
          aria-expanded={explainMenu}
          disabled={busy}
          onClick={() => setExplainMenu((o) => !o)}
        >
          <ChevronDown size={12} />
        </button>
        {explainMenu ? (
          <>
            <div
              className={styles.menuScrim}
              onMouseDown={() => setExplainMenu(false)}
              aria-hidden="true"
            />
            <div className={styles.explainMenu}>
              <Menu
                aria-label="Explain options"
                items={[{ id: "analyze", label: "Explain Analyze…" }]}
                onClose={() => setExplainMenu(false)}
                onSelect={() => {
                  setExplainMenu(false);
                  void explainActive(true);
                }}
              />
            </div>
          </>
        ) : null}
      </span>
      {transactional ? (
        <span className={styles.splitButton}>
          <button
            type="button"
            className={styles.tbButton}
            aria-haspopup="menu"
            aria-expanded={txMenu}
            onClick={() => setTxMenu((o) => !o)}
          >
            Tx: {txMode === "manual" ? "Manual" : "Auto-commit"}
            <ChevronDown size={12} />
          </button>
          {txMenu ? (
            <>
              <div
                className={styles.menuScrim}
                onMouseDown={() => setTxMenu(false)}
                aria-hidden="true"
              />
              <div className={styles.explainMenu}>
                <Menu
                  aria-label="Transaction mode"
                  items={[
                    { id: "auto", label: `${txMode === "auto" ? "✓ " : ""}Auto-commit` },
                    { id: "manual", label: `${txMode === "manual" ? "✓ " : ""}Manual` },
                  ]}
                  onClose={() => setTxMenu(false)}
                  onSelect={(id) => {
                    setTxMenu(false);
                    void setTxMode(tabId, id as "auto" | "manual");
                  }}
                />
              </div>
            </>
          ) : null}
        </span>
      ) : null}
      {transactional && txMode === "manual" ? (
        <>
          <button
            type="button"
            className={styles.tbButton}
            disabled={!txOpen || busy}
            onClick={() => void endActiveTransaction(true)}
          >
            Commit
          </button>
          <button
            type="button"
            className={styles.tbButton}
            disabled={!txOpen || busy}
            onClick={() => void endActiveTransaction(false)}
          >
            Rollback
          </button>
          {txOpen ? (
            <span className={styles.pending} role="status">
              {txPending} pending
            </span>
          ) : null}
        </>
      ) : null}
    </>
  );
}
