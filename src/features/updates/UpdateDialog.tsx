import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import { installAndRestart } from "./updater";
import { useUpdates } from "./updateStore";
import styles from "./Updates.module.css";

/** "Clew <version> is available": notes, then Install and restart or Later. */
export function UpdateDialog() {
  const open = useUpdates((s) => s.dialogOpen);
  const status = useUpdates((s) => s.status);
  const close = useUpdates((s) => s.closeDialog);
  if (!open || (status.kind !== "available" && status.kind !== "installing")) return null;
  const installing = status.kind === "installing";
  return (
    <Dialog
      title="Update available"
      maxWidth={520}
      onClose={() => {
        if (!installing) close();
      }}
      footer={
        <>
          <Button variant="default" disabled={installing} onClick={close}>
            Later
          </Button>
          <Button variant="primary" disabled={installing} onClick={() => void installAndRestart()}>
            {installing ? "Installing…" : "Install and restart"}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        {status.kind === "available" ? (
          <>
            <h2 className={styles.version}>Clew {status.version}</h2>
            {status.notes ? (
              <pre className={styles.notes} aria-label="Release notes">
                {status.notes}
              </pre>
            ) : (
              <p className={styles.muted}>No release notes.</p>
            )}
            <p className={styles.muted}>
              Clew restarts to finish the update. Unsaved work and open transactions are checked
              first.
            </p>
          </>
        ) : (
          <p role="status">
            Installing the update
            {status.percent !== null ? ` · ${status.percent}%` : "…"} Clew restarts when it is done.
          </p>
        )}
      </div>
    </Dialog>
  );
}
