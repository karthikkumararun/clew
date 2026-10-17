import { Terminal } from "../../components/icons";
import type { EditRef } from "./chatStore";
import { jumpToChanges, keepAll, undoAll, useReview } from "./review";
import styles from "./Panel.module.css";

/** The "Edited <console>" card in the chat; it reads the same hunk state as the review bar. */
export function EditCard({ edit }: { edit: EditRef }) {
  const info = useReview((s) => s.results[edit.reviewId]);
  const live = useReview((s) => s.byTab[edit.tabId]);
  if (!info) return null;
  const active = info.active && live?.id === edit.reviewId;
  const status = active
    ? "Pending review"
    : info.kept > 0 && info.undone > 0
      ? `${info.kept} kept · ${info.undone} undone`
      : info.undone > 0
        ? "Undone"
        : "Kept";
  return (
    <div className={styles.editCard} data-testid="edit-card">
      <div className={styles.editHead}>
        <Terminal size={13} className={styles.editIcon} />
        <span>
          Edited <span className={styles.mono}>{edit.tabName}</span>
        </span>
        <span className={styles.added}>+{info.added}</span>
        <span className={styles.removed}>−{info.removed}</span>
        <span className={styles.editStatus} data-active={active}>
          {active ? <span className={styles.pendingDot} /> : null}
          {status}
        </span>
      </div>
      <div className={styles.editLines}>
        {info.lines.map((l, i) => (
          <div key={i} className={styles.editLine}>
            <span className={styles.lineNo}>{l.label}</span>
            <span data-insert={l.insert}>{l.text}</span>
          </div>
        ))}
      </div>
      {active ? (
        <div className={styles.editActions}>
          <button type="button" className={styles.primarySmall} onClick={() => keepAll(edit.tabId)}>
            Keep all
          </button>
          <button type="button" className={styles.small} onClick={() => undoAll(edit.tabId)}>
            Undo all
          </button>
          <button
            type="button"
            className={styles.ghostSmall}
            onClick={() => jumpToChanges(edit.tabId)}
          >
            Jump to changes
          </button>
        </div>
      ) : null}
    </div>
  );
}
