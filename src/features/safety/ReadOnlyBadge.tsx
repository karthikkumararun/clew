import { useState } from "react";
import { Menu } from "../../components/Menu";
import { confirmSwitchToReadWrite } from "./switch";
import styles from "./Safety.module.css";

export interface ReadOnlyBadgeProps {
  connectionName: string;
  environment: string;
  readOnly: boolean;
  /** Switch the session; the badge only asks. */
  onChange: (readOnly: boolean) => void;
}

/**
 * `PRODUCTION · READ-ONLY` / `PRODUCTION · READ-WRITE` (and plain `READ-ONLY` elsewhere). Clicking
 * offers to switch this session; going read-write asks first.
 */
export function ReadOnlyBadge({
  connectionName,
  environment,
  readOnly,
  onChange,
}: ReadOnlyBadgeProps) {
  const [open, setOpen] = useState(false);
  const production = environment === "production";
  if (!production && !readOnly) return null;

  const label = `${production ? "PRODUCTION · " : ""}${readOnly ? "READ-ONLY" : "READ-WRITE"}`;

  const choose = async () => {
    setOpen(false);
    if (!readOnly) {
      onChange(true);
      return;
    }
    if (await confirmSwitchToReadWrite(connectionName)) onChange(false);
  };

  return (
    <span className={styles.badgeWrap}>
      <button
        type="button"
        className={styles.badge}
        data-mode={readOnly ? "read" : "write"}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          readOnly
            ? "This session refuses writes. Click to switch it to read-write."
            : "This session can write. Click to switch it back to read-only."
        }
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open ? (
        <>
          <div className={styles.scrim} onMouseDown={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.menuHost}>
            <Menu
              aria-label="Session mode"
              items={[
                {
                  id: "toggle",
                  label: readOnly
                    ? "Switch this session to read-write"
                    : "Switch this session to read-only",
                },
              ]}
              onClose={() => setOpen(false)}
              onSelect={() => void choose()}
            />
          </div>
        </>
      ) : null}
    </span>
  );
}
