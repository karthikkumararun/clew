import { useState } from "react";
import { Menu } from "../../components/Menu";
import { confirmSwitchToReadWrite } from "../safety/switch";
import styles from "./Graph.module.css";

const ENV_WORDS: Record<string, string> = {
  local: "LOCAL",
  development: "DEV",
  staging: "STAGING",
  production: "PRODUCTION",
};

export interface AccessBadgeProps {
  connectionName: string;
  environment: string;
  readOnly: boolean;
  /** Switch the session; the badge only asks. */
  onChange: (readOnly: boolean) => void;
}

/**
 * `STAGING · READ` / `STAGING · WRITE`: the environment and the session's access mode. Clicking
 * offers to switch this session; going read-write asks first.
 */
export function AccessBadge({ connectionName, environment, readOnly, onChange }: AccessBadgeProps) {
  const [open, setOpen] = useState(false);
  const label = `${ENV_WORDS[environment] ?? environment.toUpperCase()} · ${readOnly ? "READ" : "WRITE"}`;

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
        data-env={environment}
        data-mode={readOnly ? "read" : "write"}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          readOnly
            ? "This session refuses writes (READ access mode). Click to switch it to read-write."
            : "This session can write. Click to switch it back to read-only."
        }
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open ? (
        <>
          <div className={styles.scrim} onMouseDown={() => setOpen(false)} aria-hidden="true" />
          <div className={styles.dbMenu}>
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
