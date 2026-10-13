import { useConnections } from "../../connections/connectionsStore";
import { useSessions } from "../../stores/sessionsStore";
import { rollBackAllIdle } from "./actions";
import { plural } from "./format";
import { toggleSessionsPanel } from "./panel";
import styles from "./Sessions.module.css";

/**
 * `Sessions 4 · 1 idle in transaction`. Always on the status bar, so a hidden panel has a visible
 * way back at every window width; amber (red when a production session is flagged) with a flag.
 */
export function SessionsStatusItem() {
  const sessions = useSessions((s) => s.sessions);
  const idle = useSessions((s) => s.idle);
  const connections = useConnections((s) => s.file.connections);
  const total = Object.keys(sessions).length;
  const flagged = Object.keys(idle).filter((id) => sessions[id]);
  const production = flagged.some(
    (id) =>
      connections.find((c) => c.id === sessions[id].connectionId)?.environment === "production",
  );
  const flag = flagged.length > 0;
  return (
    <>
      <button
        type="button"
        className={styles.statusItem}
        data-flag={flag}
        data-production={production}
        title="Show or hide the Sessions panel"
        onClick={toggleSessionsPanel}
      >
        <span
          className={styles.statusDot}
          data-flag={flag}
          data-production={production}
          aria-hidden="true"
        />
        {`Sessions ${total}`}
        {flag ? ` · ${flagged.length} idle in transaction` : ""}
      </button>
      {flag ? (
        <button
          type="button"
          className={styles.statusItem}
          data-flag="true"
          data-production={production}
          aria-label={`Roll back ${plural(flagged.length, "idle session")}`}
          onClick={() => void rollBackAllIdle()}
        >
          Roll back all idle
        </button>
      ) : null}
    </>
  );
}
