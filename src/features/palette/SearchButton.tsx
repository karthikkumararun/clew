import { Search } from "../../components/icons";
import { formatShortcut } from "../../lib/platform";
import { runCommand } from "../../shell/registry/commands";
import styles from "./Palette.module.css";

/** The toolbar entry to the palette (design/canvas/Main.dc.html). */
export function SearchButton() {
  return (
    <button
      type="button"
      className={styles.trigger}
      aria-label="Go to table, query, action"
      aria-keyshortcuts="Control+K Meta+K"
      onClick={() => void runCommand("palette.open")}
    >
      <span className={styles.triggerLabel}>
        <Search size={13} strokeWidth={1.6} />
        Go to table, query, action…
      </span>
      <span className={styles.triggerKeys}>{formatShortcut("Mod+K")}</span>
    </button>
  );
}
