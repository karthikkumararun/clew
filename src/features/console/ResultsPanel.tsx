import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { IconButton } from "../../components/Button";
import { Download, Filter, Refresh } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { ExplainPane } from "./ExplainPane";
import { OutputLog } from "./OutputLog";
import { CopyAsMenu, ColumnsMenu } from "../grid/GridMenus";
import { ResultGrid } from "../grid/ResultGrid";
import type { GridHandle } from "../grid/ResultGrid";
import { RowsSource } from "../grid/source";
import type { GridSource } from "../grid/source";
import { useGridView } from "../grid/useGridView";
import { quoteIdent, flavorOf } from "../grid/sqlLiteral";
import { ExportDialog } from "../grid/ExportDialog";
import type { ExportSource } from "../grid/ExportDialog";
import { visibleColumns } from "../grid/views";
import { displayRowOf } from "../grid/tools/visibleRows";
import { useEditingUi, useEditorFor } from "../results/useResultEditing";
import { AutoRefreshMenu } from "./AutoRefreshMenu";
import { usePaging } from "./usePaging";
import { useResultTools } from "./useResultTools";
import { DocViewSwitch, DocumentsResult } from "../documents/DocResult";
import type { DocResultView } from "../documents/DocResult";
import { askChoice } from "./prompts";
import { confirmSwitchToReadWrite } from "../safety/switch";
import { formatRows } from "./runtime";
import type { ConsoleRuntime, ResultTab } from "./runtime";
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
  const resultSql = useStore(runtime.store, (s) => s.resultSql);
  const explainState = useStore(runtime.store, (s) => s.explain);
  const run = useSyncExternalStore(runtime.results.subscribe, runtime.results.getSnapshot);
  const elapsed = useElapsed(busy ? startedAt : null);

  const [filterOpen, setFilterOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [transposed, setTransposed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [docView, setDocView] = useState<DocResultView>("tree");

  const sets = useMemo(() => run.results.filter((r) => r.columns.length > 0), [run.results]);
  const active = sets.find((r) => r.key === activeKey) ?? sets[0];

  // The grid reads the streamed rows in place; a fresh source per result keeps views from mixing.
  const base = useMemo(
    () => new RowsSource(active?.columns ?? [], active?.rows ?? [], 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active?.key],
  );
  // `revision` moves when rows were changed in place (a submitted edit)
  if (active)
    base.update(active.columns, active.rows, active.rowCount + (active.revision ?? 0) * 1_000_003);
  const grid = useRef<GridHandle>(null);
  const driver =
    useConnections((s) => s.file.connections.find((c) => c.id === runtime.connectionId))?.driver ??
    "";
  // An editable result is shown through its change set: staged edits over the loaded rows.
  const editor = useEditorFor(runtime, active, base, driver);
  const editSource: GridSource = editor?.changes ?? base;
  const gv = useGridView(editSource, {
    filter,
    transposed,
    resetKey: active?.key ?? "",
    loadedRows: editor?.changes ? base.rowCount : undefined,
    // sorting and filters follow the loaded rows, not each keystroke of an edit
    indexKey: editor?.changes
      ? `${base.rowCount}:${active?.revision ?? 0}:${editSource.rowCount}`
      : undefined,
  });
  const connectionName =
    useConnections((s) => s.file.connections.find((c) => c.id === runtime.connectionId))?.name ??
    "this connection";
  // Pages mode shows a window over the rows; the window's row r is the view's row offset + r.
  const paging = usePaging({ runtime, active, view: gv.view, resetKey: active?.key ?? "" });
  const toStoreRow = (displayRow: number) => gv.toStoreRow(displayRow + paging.offset);
  const toDisplayRow = (storeRow: number) => displayRowOf(gv.visible, storeRow) - paging.offset;
  const ui = useEditingUi({
    runtime,
    editor,
    toStoreRow,
    toDisplayRow,
    grid,
    driver,
    connectionName,
    source: editSource,
  });
  const tools = useResultTools({
    runtime,
    active,
    editor,
    grid,
    view: gv.view,
    shown: paging.source,
    values: editSource,
    loadedRows: base.rowCount,
    toStoreRow,
    visible: gv.visible,
    columnFilters: gv.columnFilters,
    setColumnFilters: gv.setColumnFilters,
    resetView: gv.resetView,
    hidden: gv.hidden,
    statement: active ? resultSql[active.key] : undefined,
    driver,
    tableName: active ? sourceTable(active.columns, driver) : undefined,
    transposed,
    setTransposed,
    pageOffset: paging.offset,
  });
  const matches = gv.view.rowCount;

  const fetchMore = useCallback(() => void runtime.fetchMore(active?.key), [runtime, active?.key]);

  const range = active
    ? filter.trim()
      ? `${matches.toLocaleString()} of ${formatRows(active.rowCount, active.hasMore)} match`
      : active.rowCount === 0
        ? "0 rows"
        : `1–${active.rowCount.toLocaleString()} of ${formatRows(active.rowCount, active.hasMore)}`
    : "";

  const exportSource = (): ExportSource | null => {
    if (!active) return null;
    const v = gv.view;
    const cols = visibleColumns(v.columns.length, gv.order, gv.hidden);
    return {
      loaded: () => ({
        columns: cols.map((c) => v.columns[c]),
        rows: Array.from({ length: v.rowCount }, (_, r) => cols.map((c) => v.get(c, r))),
      }),
      loadedCount: v.rowCount,
      hasMore: active.hasMore,
      sql: resultSql[active.key],
      connectionId: runtime.connectionId,
      driver,
      tableName: sourceTable(active.columns, driver),
      name: "result",
    };
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
    <section className={styles.results} aria-label="Query results" data-shortcut-scope="grid">
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
        {tab === "result" && active && !transposed ? (
          <>
            {ui.chip}
            {ui.rowOps}
            {ui.pasteNotice}
          </>
        ) : null}
        <div className={styles.grow} />
        {tab === "result" && active ? (
          <>
            {active.docs ? <DocViewSwitch value={docView} onChange={setDocView} /> : null}
            {paging.toolbar}
            <span className={styles.range}>{range}</span>
            <AutoRefreshMenu runtime={runtime} />
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
            {tools.toolbar}
            <ColumnsMenu
              columns={active.columns}
              hidden={gv.hidden}
              onToggle={gv.toggleColumn}
              onShowAll={gv.showAll}
            />
            <CopyAsMenu grid={grid} />
            <button
              type="button"
              className={styles.exportButton}
              onClick={() => setExporting(true)}
            >
              <Download size={13} />
              Export…
            </button>
            {tools.options}
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
          active && active.docs && docView !== "table" ? (
            <div style={{ height: "100%", overflow: "auto" }}>
              <DocumentsResult
                docs={active.docs as never[]}
                view={docView}
                version={active.rowCount}
              />
              {active.hasMore ? (
                <div style={{ display: "flex", justifyContent: "center", padding: 12 }}>
                  <button type="button" className={styles.exportButton} onClick={fetchMore}>
                    Load more
                  </button>
                </div>
              ) : null}
            </div>
          ) : active ? (
            <>
              {tools.bars}
              <div className={styles.gridRow}>
                <div className={styles.gridCol}>
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
                  {tools.alt ?? (
                    <ResultGrid
                      ref={grid}
                      source={paging.source}
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
                      onSelectionChange={tools.onSelectionChange}
                      highlight={tools.highlight}
                      decorations={transposed ? undefined : ui.decorations}
                      onActivate={transposed ? undefined : ui.onActivate}
                      onCellContext={transposed ? undefined : ui.onCellContext}
                      keyColumns={transposed ? undefined : ui.keyColumns}
                      headerDetail={transposed ? undefined : ui.headerDetail}
                    />
                  )}
                  {tools.strip}
                  {transposed || tools.alt ? null : ui.footer}
                </div>
                {tools.side}
              </div>
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
        {tab === "output" ? (
          <OutputLog
            entries={output}
            onClear={() => runtime.clearOutput()}
            onAction={() => {
              void confirmSwitchToReadWrite(connectionName).then((yes) => {
                if (yes) void runtime.setReadOnly(false);
              });
            }}
          />
        ) : null}
        {tab === "explain" ? (explain ?? <ExplainPane explain={explainState} />) : null}
        {tab === "history"
          ? (history ?? <p className={styles.emptyPane}>No history yet.</p>)
          : null}
      </div>
      {ui.dialogs}
      {exporting && exportSource() ? (
        <ExportDialog source={exportSource()!} onClose={() => setExporting(false)} />
      ) : null}
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
