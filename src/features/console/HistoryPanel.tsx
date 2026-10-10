import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "../../components/Button";
import { Menu } from "../../components/Menu";
import { Check, ChevronDown, Close, Warning } from "../../components/icons";
import { relativeTime } from "../../connections/display";
import { useNotices } from "../../stores/noticesStore";
import { openConsole } from "./commands";
import { getView } from "./editor/views";
import { historyClear, historyList } from "./historyIpc";
import type { HistoryEntry } from "./historyIpc";
import { askChoice } from "./prompts";
import styles from "./Console.module.css";

const SEARCH_DEBOUNCE_MS = 200;

const flat = (sql: string) => sql.replace(/\s+/g, " ").trim();

function OutcomeIcon({ outcome }: { outcome: HistoryEntry["outcome"] }) {
  if (outcome === "ok") return <Check size={12} className={styles.histOk} aria-label="Succeeded" />;
  if (outcome === "error")
    return <Close size={12} className={styles.histError} aria-label="Failed" />;
  return <Warning size={12} className={styles.histCancelled} aria-label="Cancelled" />;
}

export interface HistoryPanelProps {
  tabId: string;
  connectionId: string;
  connectionName: string;
}

/** The History tab: this connection's statements, searchable, with Insert / Open / Copy. */
export function HistoryPanel({ tabId, connectionId, connectionName }: HistoryPanelProps) {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [clearMenu, setClearMenu] = useState(false);
  const generation = useRef(0);

  const load = useCallback(
    async (q: string, before: number | null) => {
      const mine = ++generation.current;
      setLoading(true);
      try {
        const page = await historyList(connectionId, q, before);
        if (mine !== generation.current) return;
        setEntries((cur) => (before === null ? page.entries : [...cur, ...page.entries]));
        setNext(page.next);
        setError(null);
      } catch (e) {
        if (mine === generation.current) {
          setError((e as { message?: string }).message ?? "Couldn't load the history");
        }
      } finally {
        if (mine === generation.current) setLoading(false);
      }
    },
    [connectionId],
  );

  // Search as the user types.
  useEffect(() => {
    const id = setTimeout(() => void load(query, null), query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(id);
  }, [query, load]);

  const selected = entries.find((e) => e.id === selectedId) ?? null;
  const say = (m: string) => useNotices.getState().push(m);

  const insert = (e: HistoryEntry) => {
    const view = getView(tabId);
    if (!view) return;
    view.dispatch(view.state.replaceSelection(e.sql));
    view.focus();
  };

  const copy = async (e: HistoryEntry) => {
    try {
      await navigator.clipboard.writeText(e.sql);
      say("Copied the statement");
    } catch {
      say("Couldn't copy to the clipboard");
    }
  };

  const clear = async (scope: "one" | "all") => {
    setClearMenu(false);
    const answer = await askChoice({
      title: scope === "one" ? "Clear history" : "Clear all history",
      body: (
        <p>
          {scope === "one" ? (
            <>
              Delete every recorded statement of <strong>{connectionName}</strong>? This can't be
              undone.
            </>
          ) : (
            <>Delete the recorded statements of every connection? This can't be undone.</>
          )}
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "clear", label: scope === "one" ? "Clear history" : "Clear all", variant: "primary" },
      ],
    });
    if (answer !== "clear") return;
    try {
      const n = await historyClear(scope === "one" ? connectionId : undefined);
      say(`Deleted ${n.toLocaleString()} ${n === 1 ? "entry" : "entries"}`);
      setSelectedId(null);
      void load(query, null);
    } catch (e) {
      say(`Couldn't clear the history: ${(e as { message?: string }).message ?? e}`);
    }
  };

  return (
    <div className={styles.history}>
      <div className={styles.histBar}>
        <input
          className={styles.filterInput}
          aria-label="Search history"
          placeholder="Search statements…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className={styles.exportWrap}>
          <button
            type="button"
            className={styles.exportButton}
            aria-haspopup="menu"
            aria-expanded={clearMenu}
            onClick={() => setClearMenu((o) => !o)}
          >
            Clear
            <ChevronDown size={12} />
          </button>
          {clearMenu ? (
            <>
              <div
                className={styles.menuScrim}
                onMouseDown={() => setClearMenu(false)}
                aria-hidden="true"
              />
              <div className={styles.exportMenu}>
                <Menu
                  aria-label="Clear history"
                  items={[
                    { id: "one", label: `Clear history for ${connectionName}…` },
                    { id: "all", label: "Clear history for all connections…" },
                  ]}
                  onClose={() => setClearMenu(false)}
                  onSelect={(id) => void clear(id as "one" | "all")}
                />
              </div>
            </>
          ) : null}
        </span>
      </div>

      <div className={styles.histBody}>
        <div className={styles.histList} role="listbox" aria-label="History">
          {error ? (
            <p className={styles.emptyPane} role="alert">
              {error}
            </p>
          ) : entries.length === 0 && !loading ? (
            <p className={styles.emptyPane}>
              {query
                ? "No statements match."
                : "Statements you run in this connection show up here."}
            </p>
          ) : null}
          {entries.map((e) => (
            <div
              key={e.id}
              role="option"
              tabIndex={0}
              aria-selected={e.id === selectedId}
              className={styles.histRow}
              onClick={() => setSelectedId(e.id)}
              onKeyDown={(ev) => {
                if (ev.key === "Enter" || ev.key === " ") {
                  ev.preventDefault();
                  setSelectedId(e.id);
                }
              }}
            >
              <OutcomeIcon outcome={e.outcome} />
              <code className={styles.histSql}>{flat(e.sql)}</code>
              <span className={styles.histMeta}>
                {e.rows !== null
                  ? `${e.rows.toLocaleString()} ${e.rows === 1 ? "row" : "rows"}`
                  : ""}
              </span>
              <span className={styles.histMeta}>{e.durationMs} ms</span>
              <span className={styles.histMeta}>
                {relativeTime(new Date(e.startedAt).toISOString())}
              </span>
            </div>
          ))}
          {next !== null ? (
            <button
              type="button"
              className={styles.link}
              disabled={loading}
              onClick={() => void load(query, next)}
            >
              Load more
            </button>
          ) : null}
        </div>

        {selected ? (
          <aside className={styles.histDetail} aria-label="Statement">
            <pre className={styles.histFull}>{selected.sql}</pre>
            <div className={styles.histActions}>
              <Button variant="default" onClick={() => insert(selected)}>
                Insert into editor
              </Button>
              <Button
                variant="default"
                onClick={() => void openConsole({ connectionId, sql: selected.sql })}
              >
                Open in new console
              </Button>
              <Button variant="default" onClick={() => void copy(selected)}>
                Copy
              </Button>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
