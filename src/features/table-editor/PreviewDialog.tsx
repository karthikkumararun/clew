import { Button } from "../../components/Button";
import { Dialog } from "../../components/Dialog";
import type { PreviewStatement } from "./api";
import styles from "./TableEditor.module.css";

export function PreviewDialog({
  statements,
  error,
  onCopy,
  onOpenInConsole,
  onClose,
}: {
  statements: PreviewStatement[] | null;
  error: string | null;
  onCopy: (sql: string) => void;
  onOpenInConsole: (sql: string) => void;
  onClose: () => void;
}) {
  const sql = (statements ?? []).map((s) => s.sql).join("\n");
  return (
    <Dialog
      title="Preview SQL"
      maxWidth={760}
      onClose={onClose}
      footer={
        <>
          <Button variant="default" disabled={!sql} onClick={() => onCopy(sql)}>
            Copy
          </Button>
          <Button variant="default" disabled={!sql} onClick={() => onOpenInConsole(sql)}>
            Open in console
          </Button>
          <div className={styles.grow} />
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {error ? (
        <p className={styles.inputError} role="alert">
          {error}
        </p>
      ) : statements === null ? (
        <p className={styles.viewEmpty}>Preparing…</p>
      ) : (
        <pre className={styles.previewSql} aria-label="Generated SQL">
          {sql}
        </pre>
      )}
      <p className={styles.cellMeta}>
        Values are sent as bound parameters when you submit; they are written out here for reading.
        All statements run in one transaction.
      </p>
    </Dialog>
  );
}
