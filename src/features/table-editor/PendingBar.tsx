import { Button } from "../../components/Button";
import type { Counts } from "./changeSet";
import styles from "./TableEditor.module.css";

export interface PendingBarProps {
  counts: Counts;
  submitting: boolean;
  error: { message: string; conflict: boolean } | null;
  submitShortcut: string;
  onPreview: () => void;
  onRevert: () => void;
  onSubmit: () => void;
  onReload: () => void;
}

export function breakdown(c: Counts): string {
  return [
    c.edited ? `${c.edited} edited` : null,
    c.inserted ? `${c.inserted} inserted` : null,
    c.deleted ? `${c.deleted} deleted` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Shown while edits are staged: what will change, and the way to write or drop it. */
export function PendingBar(p: PendingBarProps) {
  const { total } = p.counts;
  if (total === 0) return null;
  return (
    <div className={styles.pendingBar} role="region" aria-label="Pending changes">
      <strong>
        {total} pending {total === 1 ? "change" : "changes"}
      </strong>
      <span className={styles.pendingText}>
        {breakdown(p.counts)} — nothing is written until you submit
      </span>
      {p.error ? (
        <span className={styles.pendingError} role="alert">
          {p.error.conflict ? "Row changed by someone else: " : "Submit failed: "}
          {p.error.message}
        </span>
      ) : null}
      <div className={styles.grow} />
      {p.error?.conflict ? (
        <Button variant="default" onClick={p.onReload}>
          Reload
        </Button>
      ) : null}
      <Button variant="default" onClick={p.onPreview}>
        Preview SQL
      </Button>
      <Button variant="default" onClick={p.onRevert} disabled={p.submitting}>
        Revert all
      </Button>
      <Button variant="primary" onClick={p.onSubmit} disabled={p.submitting}>
        {p.submitting ? "Submitting…" : `Submit ${p.submitShortcut}`}
      </Button>
    </div>
  );
}
