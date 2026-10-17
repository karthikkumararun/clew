import { IconButton } from "../../components/Button";
import { ChevronDown, ChevronUp, Star } from "../../components/icons";
import { formatShortcut } from "../../lib/platform";
import { goToHunk, keepAll, undoAll, useReview } from "./review";
import styles from "./Review.module.css";

/** The floating bar over the editor while AI hunks wait for a decision. */
export function ReviewBar({ tabId }: { tabId: string }) {
  const r = useReview((s) => s.byTab[tabId]);
  if (!r?.active || r.hunks.length === 0) return null;
  const n = r.hunks.length;
  return (
    <div
      className={styles.bar}
      role="toolbar"
      aria-label="Review AI edits"
      data-testid="review-bar"
    >
      <Star size={13} className={styles.star} />
      <span className={styles.label}>
        AI edited {n} {n === 1 ? "hunk" : "hunks"}
      </span>
      <span className={styles.added}>+{r.added}</span>
      <span className={styles.removed}>−{r.removed}</span>
      <span className={styles.nav}>
        <IconButton aria-label="Previous change" onClick={() => goToHunk(tabId, -1)}>
          <ChevronUp size={12} />
        </IconButton>
        <span aria-live="polite">
          {r.current + 1} / {n}
        </span>
        <IconButton aria-label="Next change" onClick={() => goToHunk(tabId, 1)}>
          <ChevronDown size={12} />
        </IconButton>
      </span>
      <button type="button" className={styles.undoAll} onClick={() => undoAll(tabId)}>
        Undo all <span className={styles.keys}>{formatShortcut("Mod+Backspace")}</span>
      </button>
      <button type="button" className={styles.keepAll} onClick={() => keepAll(tabId)}>
        Keep all <span className={styles.keys}>{formatShortcut("Mod+Enter")}</span>
      </button>
    </div>
  );
}
