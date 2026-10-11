import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { DRIVER_BADGES, ENV_COLORS, Kbd } from "../components/Badge";
import { ClewMark } from "../components/ClewMark";
import { File, Import, Plus } from "../components/icons";
import { useConnections } from "../connections/connectionsStore";
import { appPaths } from "../lib/ipc";
import type { AppPaths } from "../lib/ipc";
import { formatShortcut } from "../lib/platform";
import { runCommand } from "./registry/commands";
import { useRecents } from "./registry/recents";
import styles from "./Welcome.module.css";

const HINTS: { keys: string; label: string }[] = [
  { keys: "Mod+K", label: "Go to anything" },
  { keys: "Mod+Enter", label: "Run statement" },
  { keys: "Mod+E", label: "Recent files" },
  { keys: "Mod+,", label: "Settings" },
];

function useAppPaths(): AppPaths | null {
  const [paths, setPaths] = useState<AppPaths | null>(null);
  useEffect(() => {
    let live = true;
    appPaths()
      .then((p) => live && setPaths(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);
  return paths;
}

export function Welcome() {
  const recents = useRecents((s) => s.recents);
  const paths = useAppPaths();
  const [url, setUrl] = useState("");
  const urlError = useConnections((s) => s.urlError);
  const setUrlError = useConnections((s) => s.setUrlError);

  const connect = (e: FormEvent) => {
    e.preventDefault();
    const value = url.trim();
    if (value) void runCommand("connection.fromUrl", value);
  };

  return (
    <div className={styles.scroll} data-testid="welcome">
      <div className={styles.page}>
        <svg
          className={styles.thread}
          aria-hidden="true"
          viewBox="0 0 1440 900"
          preserveAspectRatio="none"
        >
          <path d="M-20 760 C 180 700, 220 560, 380 600 S 560 820, 700 700 S 820 420, 980 470 S 1200 640, 1300 520 S 1400 260, 1470 300" />
        </svg>

        <div className={styles.grid}>
          <div className={styles.col}>
            <div className={styles.identity}>
              <ClewMark size={56} />
              <div className={styles.titleBlock}>
                <h1 className={styles.title}>Clew</h1>
                <span className={styles.byline}>by ADK</span>
              </div>
              <p className={styles.tagline}>
                An open-source database IDE. One window for Postgres, MySQL, SQLite, MongoDB and
                Redis — and a thread back out of every labyrinth.
              </p>
            </div>

            <div className={styles.actions}>
              <button
                type="button"
                className={`${styles.act} ${styles.actPrimary}`}
                onClick={() => void runCommand("connection.new")}
              >
                <span className={styles.actIcon}>
                  <Plus size={18} strokeWidth={1.6} />
                </span>
                <span className={styles.actLabel}>New connection</span>
                <span className={styles.actHint}>{formatShortcut("Mod+N")}</span>
              </button>
              <button
                type="button"
                className={styles.act}
                onClick={() => void runCommand("connection.import")}
              >
                <span className={styles.actIcon}>
                  <Import size={18} strokeWidth={1.4} />
                </span>
                <span className={styles.actLabel}>
                  Import connections
                  <small>
                    From DataGrip (with SQL consoles), DBeaver, ~/.pgpass or a Clew export
                  </small>
                </span>
              </button>
              <button
                type="button"
                className={styles.act}
                onClick={() => void runCommand("file.openDatabase")}
              >
                <span className={styles.actIcon}>
                  <File size={18} strokeWidth={1.4} />
                </span>
                <span className={styles.actLabel}>
                  Open a database file
                  <small>SQLite, DuckDB — or drag one onto this window</small>
                </span>
                <span className={styles.actHint}>{formatShortcut("Mod+O")}</span>
              </button>
            </div>

            <form onSubmit={connect}>
              <label htmlFor="welcome-url" className={styles.label}>
                Or paste a connection URL
              </label>
              <div className={styles.urlRow}>
                <input
                  id="welcome-url"
                  className={`${styles.url} mono`}
                  placeholder="postgres://user@host:5432/db"
                  value={url}
                  onChange={(e) => {
                    setUrl(e.target.value);
                    if (urlError) setUrlError(null);
                  }}
                  aria-invalid={Boolean(urlError)}
                  aria-describedby={urlError ? "welcome-url-error" : undefined}
                  autoComplete="off"
                  spellCheck={false}
                />
                <button type="submit" className={styles.connect} disabled={!url.trim()}>
                  Connect
                </button>
              </div>
              {urlError ? (
                <p id="welcome-url-error" role="alert" className={styles.urlError}>
                  {urlError}
                </p>
              ) : null}
              <p className={styles.urlHelp}>
                Driver, host and database are detected from the URL; you&apos;ll confirm before
                anything is saved.
              </p>
            </form>
          </div>

          <div className={styles.recentCol}>
            <div className={styles.recentHead}>
              <h2>Recent</h2>
              {recents.length > 0 ? (
                <button
                  type="button"
                  className={styles.linkBtn}
                  onClick={() => void runCommand("connection.manage")}
                >
                  All connections
                </button>
              ) : null}
            </div>
            <div className={styles.recents}>
              {recents.length === 0 ? (
                <div className={styles.empty}>
                  <strong>No connections yet</strong>
                  Create one, import your existing ones, or paste a URL.
                </div>
              ) : (
                recents.map((r) => (
                  <button
                    key={r.id}
                    type="button"
                    className={styles.rc}
                    onClick={() => void runCommand("connection.open", r.id)}
                  >
                    <span className={styles.rcBar} style={{ background: ENV_COLORS[r.env] }} />
                    <span
                      className={styles.driver}
                      style={{ background: DRIVER_BADGES[r.driver].color }}
                    >
                      {DRIVER_BADGES[r.driver].code}
                    </span>
                    <span className={styles.rcBody}>
                      <span className={styles.rcName}>{r.name}</span>
                      <span className={`${styles.rcDetail} mono`}>{r.detail}</span>
                    </span>
                    <span className={styles.rcWhen}>{r.lastUsed}</span>
                  </button>
                ))
              )}
            </div>
            <div className={styles.hints}>
              {HINTS.map((h) => (
                <span key={h.keys} className={styles.hint}>
                  <Kbd>{formatShortcut(h.keys)}</Kbd> {h.label}
                </span>
              ))}
            </div>
          </div>
        </div>

        <p className={styles.footer}>
          Connections live in{" "}
          <span className="mono selectable" data-testid="connections-path">
            {paths?.connectionsFileDisplay ?? "…"}
          </span>{" "}
          · passwords stay in your system keychain · v{paths?.appVersion ?? "…"}
        </p>
      </div>
    </div>
  );
}
