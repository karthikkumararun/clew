import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { IconButton } from "../../components/Button";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { ChevronDown, Download, Filter, Refresh } from "../../components/icons";
import { useNotices } from "../../stores/noticesStore";
import { ExplainPane } from "./ExplainPane";
import { OutputLog } from "./OutputLog";
import { ResultTable } from "./ResultTable";
import { formatRows } from "./runtime";
import type { ConsoleRuntime, ResultTab } from "./runtime";
import { toCsv, toJson, toTsv } from "./valueFormat";
import { valueText } from "./valueFormat";
import type { ResultView } from "../../lib/ipc/queryRun";
import styles from "./Console.module.css";

const TABS: { id: ResultTab; label: string }[] = [
  { id: "result", label: "Result" },
  { id: "output", label: "Output" },
  { id: "explain", label: "Explain plan" },
  { id: "history", label: "History" },
];

/** Seconds since `startedAt`, ticking while a statement runs. */
export function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(id);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

export const formatElapsed = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Rows of a result, narrowed by the filter text (substring over every cell). */
export function filterRows(result: ResultView, filter: string) {
  const needle = filter.trim().toLowerCase();
  if (!needle) return { rows: result.rows, numbers: undefined };
  const rows: ResultView["rows"] = [];
  const numbers: number[] = [];
  result.rows.forEach((row, i) => {
    if (row.some((v) => valueText(v)?.toLowerCase().includes(needle))) {
      rows.push(row);
      numbers.push(i + 1);
    }
  });
  return { rows, numbers };
}

/** Columns become rows: one line per column, one column per (first) row. */
export function transpose(result: ResultView, limit = 50) {
  const shown = result.rows.slice(0, limit);
  const columns = [
    { name: "column", type_name: "", kind: "text" as const, nullable: false },
    ...shown.map((_, i) => ({
      name: `#${i + 1}`,
      type_name: "",
      kind: "text" as const,
      nullable: null,
    })),
  ];
  const rows = result.columns.map((c, ci) => [
    { kind: "text" as const, value: c.name },
    ...shown.map((r) => r[ci]),
  ]);
  return { columns, rows };
}

export interface ResultsPanelProps {
  runtime: ConsoleRuntime;
  onRerun: () => void;
  /** Bodies owned by later pieces of the console. */
  explain?: React.ReactNode;
  history?: React.ReactNode;
}

export function ResultsPanel({ runtime, onRerun, explain, history }: ResultsPanelProps) {
  const tab = useStore(runtime.store, (s) => s.tab);
  const busy = useStore(runtime.store, (s) => s.busy);
  const startedAt = useStore(runtime.store, (s) => s.startedAt);
  const output = useStore(runtime.store, (s) => s.output);
  const activeKey = useStore(runtime.store, (s) => s.activeResult);
  const lastRun = useStore(runtime.store, (s) => s.lastRun);
  const explainState = useStore(runtime.store, (s) => s.explain);
  const run = useSyncExternalStore(runtime.results.subscribe, runtime.results.getSnapshot);
  const elapsed = useElapsed(busy ? startedAt : null);

  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [transposed, setTransposed] = useState(false);
  const [exportMenu, setExportMenu] = useState(false);

  const sets = useMemo(() => run.results.filter((r) => r.columns.length > 0), [run.results]);
  const active = sets.find((r) => r.key === activeKey) ?? sets[0];

  const filtered = useMemo(
    () => (active ? filterRows(active, filter) : { rows: [], numbers: undefined }),
    [active, filter],
  );
  const view = useMemo(() => {
    if (!active) return null;
    return transposed
      ? { ...transpose(active), numbers: undefined }
      : { columns: active.columns, rows: filtered.rows, numbers: filtered.numbers };
  }, [active, transposed, filtered]);

  const fetchMore = useCallback(() => void runtime.fetchMore(active?.key), [runtime, active?.key]);

  const range = active
    ? filter.trim()
      ? `${filtered.rows.length.toLocaleString()} of ${formatRows(active.rowCount, active.hasMore)} match`
      : active.rowCount === 0
        ? "0 rows"
        : `1–${active.rowCount.toLocaleString()} of ${formatRows(active.rowCount, active.hasMore)}`
    : "";

  const say = (m: string) => useNotices.getState().push(m);
  const exportItems: MenuItem[] = [
    { id: "csv", label: "Copy as CSV", disabled: !active },
    { id: "tsv", label: "Copy as TSV", disabled: !active },
    { id: "json", label: "Copy as JSON", disabled: !active },
  ];
  const exportAs = async (id: string) => {
    setExportMenu(false);
    if (!active) return;
    const names = active.columns.map((c) => c.name);
    const text =
      id === "csv"
        ? toCsv(names, filtered.rows)
        : id === "tsv"
          ? toTsv(names, filtered.rows)
          : toJson(names, filtered.rows);
    try {
      await navigator.clipboard.writeText(text);
      say(`Copied ${filtered.rows.length.toLocaleString()} rows as ${id.toUpperCase()}`);
    } catch {
      say("Couldn't copy to the clipboard");
    }
  };

  const resultLabel = busy
    ? `Running · ${formatElapsed(elapsed)}`
    : active
      ? `${active.rowCount.toLocaleString()}${active.hasMore ? "+" : ""} ${active.rowCount === 1 && !active.hasMore ? "row" : "rows"}${active.summary ? ` · ${active.summary.elapsed_ms} ms` : ""}`
      : null;

  return (
    <section className={styles.results} aria-label="Query results">
      <div className={styles.resultsHeader}>
        <div role="tablist" aria-label="Result views" className={styles.resultTabs}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              className={styles.resultTab}
              onClick={() => runtime.setTab(t.id)}
            >
              {t.label}
              {t.id === "result" && resultLabel ? (
                <span className={styles.resultTabMeta}>
                  {busy ? (
                    <span className={styles.spinner} role="img" aria-label="Running" />
                  ) : null}
                  {" · "}
                  {resultLabel}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <div className={styles.grow} />
        {tab === "result" && active ? (
          <>
            <span className={styles.range}>{range}</span>
            <IconButton aria-label="Re-run query" disabled={!lastRun || busy} onClick={onRerun}>
              <Refresh size={14} />
            </IconButton>
            <IconButton
              aria-label="Filter results"
              aria-pressed={filterOpen}
              onClick={() => {
                setFilterOpen((o) => !o);
                if (filterOpen) setFilter("");
              }}
            >
              <Filter size={14} />
            </IconButton>
            <IconButton
              aria-label="Transpose"
              aria-pressed={transposed}
              onClick={() => setTransposed((t) => !t)}
            >
              <TransposeIcon />
            </IconButton>
            <span className={styles.exportWrap}>
              <button
                type="button"
                className={styles.exportButton}
                aria-haspopup="menu"
                aria-expanded={exportMenu}
                onClick={() => setExportMenu((o) => !o)}
              >
                <Download size={13} />
                Export
                <ChevronDown size={12} />
              </button>
              {exportMenu ? (
                <>
                  <div
                    className={styles.menuScrim}
                    onMouseDown={() => setExportMenu(false)}
                    aria-hidden="true"
                  />
                  <div className={styles.exportMenu}>
                    <Menu
                      aria-label="Export results"
                      items={exportItems}
                      onClose={() => setExportMenu(false)}
                      onSelect={(id) => void exportAs(id)}
                    />
                  </div>
                </>
              ) : null}
            </span>
          </>
        ) : null}
      </div>

      {tab === "result" && filterOpen ? (
        <div className={styles.filterBar}>
          <input
            className={styles.filterInput}
            aria-label="Filter rows"
            placeholder="Filter loaded rows…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
          />
        </div>
      ) : null}

      {tab === "result" && sets.length > 1 ? (
        <div role="tablist" aria-label="Result sets" className={styles.subTabs}>
          {sets.map((r, i) => (
            <button
              key={r.key}
              type="button"
              role="tab"
              aria-selected={r.key === active?.key}
              className={styles.subTab}
              onClick={() => runtime.setActiveResult(r.key)}
            >
              Result {i + 1}
            </button>
          ))}
        </div>
      ) : null}

      <div className={styles.resultsBody}>
        {tab === "result" ? (
          view && active ? (
            <ResultTable
              columns={view.columns}
              rows={view.rows}
              rowNumbers={view.numbers}
              hasMore={active.hasMore && !transposed}
              fetching={run.fetching}
              onNearEnd={fetchMore}
            />
          ) : (
            <p className={styles.emptyPane}>
              {busy
                ? "Running…"
                : run.status === "idle"
                  ? "Run a statement to see its rows here."
                  : "No rows to show — see Output."}
            </p>
          )
        ) : null}
        {tab === "output" ? <OutputLog entries={output} /> : null}
        {tab === "explain" ? (explain ?? <ExplainPane explain={explainState} />) : null}
        {tab === "history"
          ? (history ?? <p className={styles.emptyPane}>No history yet.</p>)
          : null}
      </div>
    </section>
  );
}

function TransposeIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <path d="M3 3h4v10H3zM9 3h4v4H9z" />
    </svg>
  );
}
