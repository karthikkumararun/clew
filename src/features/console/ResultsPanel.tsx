import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { IconButton } from "../../components/Button";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { ChevronDown, Download, Filter, Refresh } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { useNotices } from "../../stores/noticesStore";
import { ExplainPane } from "./ExplainPane";
import { OutputLog } from "./OutputLog";
import { CopyAsMenu, ColumnsMenu } from "../grid/GridMenus";
import { ResultGrid } from "../grid/ResultGrid";
import type { GridHandle } from "../grid/ResultGrid";
import { RowsSource } from "../grid/source";
import { useGridView } from "../grid/useGridView";
import { quoteIdent, flavorOf } from "../grid/sqlLiteral";
import { askChoice } from "./prompts";
import { formatRows } from "./runtime";
import type { ConsoleRuntime, ResultTab } from "./runtime";
import { toCsv, toJson, toTsv } from "./valueFormat";
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

/** The statement wrapped so the database sorts it (the client only sorted what was loaded). */
export function orderedSql(
  sql: string,
  driver: string,
  column: string,
  dir: "asc" | "desc",
): string {
  const flavor = flavorOf(driver);
  const inner = sql.trim().replace(/;+\s*$/, "");
  const alias = flavor === "oracle" ? "clew_sorted" : "AS clew_sorted";
  return `SELECT * FROM (${inner}) ${alias} ORDER BY ${quoteIdent(flavor, column)} ${dir.toUpperCase()}`;
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

  // The grid reads the streamed rows in place; a fresh source per result keeps views from mixing.
  const base = useMemo(
    () => new RowsSource(active?.columns ?? [], active?.rows ?? [], 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active?.key],
  );
  if (active) base.update(active.columns, active.rows, active.rowCount);
  const grid = useRef<GridHandle>(null);
  const gv = useGridView(base, { filter, transposed, resetKey: active?.key ?? "" });
  const driver =
    useConnections((s) => s.file.connections.find((c) => c.id === runtime.connectionId))?.driver ??
    "";
  const matches = gv.view.rowCount;

  const fetchMore = useCallback(() => void runtime.fetchMore(active?.key), [runtime, active?.key]);

  const range = active
    ? filter.trim()
      ? `${matches.toLocaleString()} of ${formatRows(active.rowCount, active.hasMore)} match`
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
    const v = gv.view;
    const names = v.columns.map((c) => c.name);
    const rows = Array.from({ length: v.rowCount }, (_, r) => v.columns.map((_, c) => v.get(c, r)));
    const text =
      id === "csv" ? toCsv(names, rows) : id === "tsv" ? toTsv(names, rows) : toJson(names, rows);
    try {
      await navigator.clipboard.writeText(text);
      say(`Copied ${rows.length.toLocaleString()} rows as ${id.toUpperCase()}`);
    } catch {
      say("Couldn't copy to the clipboard");
    }
  };

  const reorderInDatabase = async () => {
    if (!gv.sort || !lastRun || !active) return;
    const column = active.columns[gv.sort.column]?.name;
    if (!column) return;
    const answer = await askChoice({
      title: "Re-run with ORDER BY",
      body: (
        <p>
          Run the statement again so the database sorts all rows by <strong>{column}</strong>{" "}
          {gv.sort.dir === "asc" ? "ascending" : "descending"}? The statement is wrapped in a
          subquery.
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "run", label: "Re-run", variant: "primary" },
      ],
    });
    if (answer === "run") {
      await runtime.run({
        sql: orderedSql(lastRun.sql, driver, column, gv.sort.dir),
        script: false,
        offset: lastRun.offset,
      });
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
            <ColumnsMenu
              columns={active.columns}
              hidden={gv.hidden}
              onToggle={gv.toggleColumn}
              onShowAll={gv.showAll}
            />
            <CopyAsMenu grid={grid} />
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
          active ? (
            <>
              {gv.sort && active.hasMore && !transposed ? (
                <div className={styles.sortNotice} role="status">
                  Sorted {active.rowCount.toLocaleString()} loaded rows —{" "}
                  <button
                    type="button"
                    className={styles.link}
                    onClick={() => void reorderInDatabase()}
                  >
                    Re-run with ORDER BY
                  </button>
                </div>
              ) : null}
              <ResultGrid
                ref={grid}
                source={gv.view}
                driver={driver}
                tableName={sourceTable(active.columns, driver)}
                sort={gv.sort}
                onSort={gv.onSort}
                hidden={gv.hidden}
                order={gv.order}
                onOrderChange={gv.setOrder}
                widths={gv.widths}
                onWidthsChange={gv.setWidths}
                onNearEnd={fetchMore}
              />
            </>
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

/** The table a result came from, when every column names the same one. */
function sourceTable(columns: { source_table?: string }[], driver: string): string | undefined {
  const names = new Set(columns.map((c) => c.source_table).filter(Boolean));
  if (names.size !== 1) return undefined;
  const flavor = flavorOf(driver);
  return [...names][0]!
    .split(".")
    .map((part) => quoteIdent(flavor, part))
    .join(".");
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
