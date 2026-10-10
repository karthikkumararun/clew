import { useStore } from "zustand";
import { Play } from "../../components/icons";
import { formatShortcut } from "../../lib/platform";
import { useWorkspace } from "../../stores/workspaceStore";
import { cancelActive, runActive } from "./commands";
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
  return (
    <>
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
    </>
  );
}
