/**
 * The grid tools around a console result (spec: data-grid): View as Table / Tree / Text with
 * Transpose, find on page, per-column local filters, the aggregate of the selected cells, the
 * value editor, and the options menu with Go to row and Related rows. This hook owns their state
 * and hands the panel the pieces to place.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { IconButton } from "../../components/Button";
import { Filter, Search } from "../../components/icons";
import { formatShortcut } from "../../lib/platform";
import type { Value } from "../../lib/ipc/drivers";
import type { ResultView } from "../../lib/ipc/queryRun";
import { registerShortcut } from "../../shell/registry/shortcuts";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { runCommand } from "../../shell/registry/commands";
import type { GridHandle } from "../grid/ResultGrid";
import type { GridSource } from "../grid/source";
import { flavorOf } from "../grid/sqlLiteral";
import type { SelectedCells } from "../grid/selection";
import { findRowByKey } from "../grid/tools/gridOptions";
import type { GoToTarget } from "../grid/tools/gridOptions";
import { hiddenPending } from "../grid/tools/localFilter";
import type { ColumnFilter } from "../grid/tools/localFilter";
import type { ExtractorColumn } from "../grid/tools/viewAs";
import { AggregateStrip } from "../grid/tools/ui/AggregateStrip";
import { registerAggregateShortcut } from "../grid/tools/ui/aggregateShortcut";
import { aggregateClipboardText } from "../grid/tools/aggregate";
import type { AggregateResult } from "../grid/tools/aggregate";
import { FindBar } from "../grid/tools/ui/FindBar";
import { LocalFilterBar } from "../grid/tools/ui/LocalFilterBar";
import { GridOptionsMenu } from "../results/tools/GridOptionsMenu";
import { ResultTextView } from "../results/tools/TextView";
import { ResultTreeView } from "../results/tools/TreeView";
import { ValueEditorPanel } from "../results/tools/ValueEditorPanel";
import { ViewAs } from "../results/tools/ViewAs";
import type { ViewMode } from "../results/tools/ViewAs";
import { useExtractorOptions } from "../results/tools/useExtractorOptions";
import { targetPath } from "../results/api";
import type { ResultEditor } from "../results/ResultEditor";
import { fileOpenDialog, fileSaveDialog } from "./fileIpc";
import { tableMeta } from "../table-editor/api";
import type { TableMeta } from "../table-editor/api";
import type { ConsoleRuntime } from "./runtime";

export interface ResultTools {
  /** In the toolbar: View as, find, local filter. */
  toolbar: ReactNode;
  /** After Export: the options menu. */
  options: ReactNode;
  /** Above the grid: find bar, filter bar. */
  bars: ReactNode;
  /** Under the grid: aggregate of the selection. */
  strip: ReactNode;
  /** Right of the grid: the value editor. */
  side: ReactNode;
  /** Replaces the grid in Tree or Text mode. */
  alt: ReactNode | null;
  mode: ViewMode;
  transposed: boolean;
  highlight:
    | { has: (row: number, col: number) => boolean; current?: { row: number; col: number } | null }
    | undefined;
  onSelectionChange: (cells: SelectedCells) => void;
}

export interface ResultToolsArgs {
  runtime: ConsoleRuntime;
  active: ResultView | undefined;
  editor: ResultEditor | null;
  grid: RefObject<GridHandle | null>;
  /** The unpaged view (sort and filters applied). */
  view: GridSource;
  /** What the grid shows (the current page in Pages mode). */
  shown: GridSource;
  /** The change set or the plain rows. */
  values: GridSource;
  loadedRows: number;
  toStoreRow: (displayRow: number) => number;
  visible: ArrayLike<number> | null;
  columnFilters: ColumnFilter[];
  setColumnFilters: (f: ColumnFilter[]) => void;
  resetView: () => void;
  hidden: ReadonlySet<number>;
  statement: string | undefined;
  driver: string;
  tableName: string | undefined;
  transposed: boolean;
  setTransposed: (t: boolean) => void;
  /** Where in the unpaged view the shown page starts. */
  pageOffset: number;
}

export function useResultTools(a: ResultToolsArgs): ResultTools {
  const { runtime, editor, grid } = a;
  const flavor = flavorOf(a.driver);
  const extractor = useExtractorOptions();
  const [mode, setMode] = useState<ViewMode>("table");
  const [sel, setSel] = useState<SelectedCells>({ cols: [], rows: [] });
  const [findOpen, setFindOpen] = useState(false);
  const [findMatchesState, setFindMatchesState] = useState<{
    lookup: ((r: number, c: number) => boolean) | null;
    current: { row: number; col: number } | null;
  }>({ lookup: null, current: null });
  const [filterOpen, setFilterOpen] = useState(false);
  const [valueOpen, setValueOpen] = useState(false);
  const [goTo, setGoTo] = useState(false);
  const [meta, setMeta] = useState<TableMeta | null>(null);
  const aggregate = useRef<AggregateResult | null>(null);

  const res = editor?.resolution?.kind === "editable" ? editor.resolution : null;

  // Foreign keys of the edit table, for Related rows.
  useEffect(() => {
    setMeta(null);
    if (!res) return;
    let live = true;
    tableMeta(runtime.connectionId, targetPath(a.driver, res.target)).then(
      (m) => live && setMeta(m),
      () => {},
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [res?.target.schema, res?.target.table, runtime.connectionId]);

  // Mod+F, Mod+G and Mod+Shift+C while this console is on screen.
  useEffect(() => {
    const on = () => useWorkspace.getState().activeTabId === runtime.tabId;
    const offs = [
      registerShortcut({
        id: "grid.find",
        keys: "Mod+F",
        scope: "grid",
        when: on,
        run: () => setFindOpen(true),
      }),
      registerShortcut({
        id: "grid.goToRow",
        keys: "Mod+G",
        scope: "grid",
        when: on,
        run: () => setGoTo(true),
      }),
      registerAggregateShortcut(() =>
        on() && aggregate.current ? aggregateClipboardText(aggregate.current) : null,
      ),
    ];
    return () => offs.forEach((o) => o());
  }, [runtime]);

  // A different result starts with the tools closed.
  useEffect(() => {
    setFindOpen(false);
    setFilterOpen(false);
    setMode("table");
  }, [a.active?.key]);

  const sourceCols = () => grid.current?.sourceColumns?.() ?? [];
  const selectedCellList = (): Value[] => {
    const cols = sourceCols();
    const out: Value[] = [];
    for (const r of sel.rows) for (const c of sel.cols) out.push(a.shown.get(cols[c] ?? c, r));
    return out;
  };
  const count = sel.rows.length * sel.cols.length;
  const oneCell =
    sel.rows.length === 1 && sel.cols.length === 1
      ? { row: sel.rows[0], col: sourceCols()[sel.cols[0]] ?? sel.cols[0] }
      : null;

  const extractorColumns: ExtractorColumn[] = a.values.columns.map((c, i) => ({
    ...c,
    computed: res ? res.columnMap[i] === null : undefined,
    generated: res
      ? !res.columns[i]?.editable && /generated/i.test(res.columns[i]?.reason ?? "")
      : undefined,
  }));
  const allStoreRows = useMemo(
    () => Array.from({ length: a.view.rowCount }, (_, i) => a.toStoreRow(i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [a.view, a.view.rowCount, a.view.version, a.toStoreRow],
  );

  const goToRow = (target: GoToTarget): string | void => {
    const col = sourceCols()[0] ?? 0;
    if (target.kind === "row") {
      const inPage = target.row - a.pageOffset;
      if (inPage < 0 || inPage >= a.shown.rowCount) return "That row is on another page";
      grid.current?.select(col, inPage);
      return;
    }
    if (!res) return "This result has no key to look up";
    const row = findRowByKey(a.values, a.visible, res.keyIndexes, target.values);
    if (row < 0) return "No row with that key is loaded";
    const inPage = row - a.pageOffset;
    if (inPage < 0 || inPage >= a.shown.rowCount) return "That row is on another page";
    grid.current?.select(col, inPage);
  };

  const hiddenCount =
    editor?.changes && a.visible
      ? hiddenPending(editor.changes.pendingRows(), a.visible, a.loadedRows)
      : 0;

  const toolbar = (
    <>
      <IconButton
        aria-label="Find on this page"
        aria-pressed={findOpen}
        title={`Find (${formatShortcut("Mod+F")})`}
        onClick={() => setFindOpen((o) => !o)}
      >
        <Search size={14} />
      </IconButton>
      <IconButton
        aria-label="Local filter"
        aria-pressed={filterOpen}
        onClick={() => setFilterOpen((o) => !o)}
      >
        <Filter size={14} />
      </IconButton>
      <ViewAs
        mode={mode}
        onMode={setMode}
        transpose={a.transposed}
        onTranspose={a.setTransposed}
        extractor={extractor}
      />
    </>
  );

  const options = (
    <GridOptionsMenu
      flavor={flavor}
      valueEditorOpen={valueOpen}
      onToggleValueEditor={() => setValueOpen((o) => !o)}
      onResetView={a.resetView}
      query={a.statement ?? null}
      onCopyQueryToConsole={(sql) =>
        void runCommand("console.new", { connectionId: runtime.connectionId, sql })
      }
      onCopyQueryToClipboard={(sql) => void navigator.clipboard.writeText(sql)}
      goTo={{
        rowCount: a.view.rowCount,
        keyColumns: res?.keyIndexes.length,
        keyNames: res?.keyColumns,
        onGo: goToRow,
        shortcutHint: formatShortcut("Mod+G"),
      }}
      goToOpen={goTo}
      onGoToOpenChange={setGoTo}
      related={
        meta && res && oneCell
          ? {
              foreignKeys: meta.foreignKeys,
              referencedBy: meta.referencedBy,
              rowValue: (name) => {
                const col = res.columnMap.findIndex((c) => c === name);
                return col < 0 ? undefined : a.values.get(col, a.toStoreRow(oneCell.row));
              },
              column: a.values.columns[oneCell.col]?.name,
              onOpenRelated: (sql) =>
                void runCommand("console.new", { connectionId: runtime.connectionId, sql }),
            }
          : undefined
      }
    />
  );

  const bars = (
    <>
      {findOpen ? (
        <FindBar
          source={a.shown}
          columns={sourceCols()}
          from={oneCell ?? undefined}
          onNavigate={(row, col) => grid.current?.select(col, row)}
          onMatches={(lookup, current) =>
            setFindMatchesState({
              lookup,
              current: current ? { row: current.row, col: current.col } : null,
            })
          }
          onClose={() => {
            setFindOpen(false);
            grid.current?.focus();
          }}
        />
      ) : null}
      {filterOpen ? (
        <LocalFilterBar
          columns={a.values.columns}
          filters={a.columnFilters}
          onChange={a.setColumnFilters}
          summary={{ shown: a.view.rowCount, total: a.loadedRows }}
          hiddenPending={hiddenCount}
        />
      ) : null}
    </>
  );

  const strip =
    count >= 2 ? (
      <AggregateStrip
        count={count}
        getCells={selectedCellList}
        selectionKey={`${a.shown.version}:${sel.rows.join(",")}:${sel.cols.join(",")}`}
        columnTypeName={a.values.columns[sourceCols()[sel.cols[0]] ?? sel.cols[0]]?.type_name}
        onResult={(r) => {
          aggregate.current = r;
        }}
      />
    ) : null;

  const valueCell = oneCell
    ? (() => {
        const store = a.toStoreRow(oneCell.row);
        return {
          key: `${a.active?.key}:${store}:${oneCell.col}`,
          column: a.values.columns[oneCell.col],
          row: oneCell.row + a.pageOffset + 1,
          value: a.values.get(oneCell.col, store),
          store,
        };
      })()
    : null;
  const valueState =
    valueCell && editor && oneCell ? editor.cellState(oneCell.col, valueCell.store) : null;
  const side = valueOpen ? (
    <ValueEditorPanel
      cell={valueCell}
      editable={!!valueState?.editable}
      readOnlyReason={valueState?.reason ?? (editor ? undefined : "This result is read-only")}
      onStage={(nv) => {
        if (valueCell && editor) editor.stage(oneCell!.col, valueCell.store, nv);
      }}
      loadFile={async () => {
        const f = await fileOpenDialog();
        return f ? new TextEncoder().encode(f.text) : null;
      }}
      saveFile={async (name, bytes) => {
        const saved = await fileSaveDialog(null, name, new TextDecoder().decode(bytes));
        if (saved) useNotices.getState().push(`Saved ${saved}`);
      }}
      onClose={() => setValueOpen(false)}
    />
  ) : null;

  const viewProps = {
    source: a.values,
    columns: extractorColumns,
    storeRows: allStoreRows,
    extractor,
    transpose: a.transposed,
    table: a.tableName,
    flavor,
  };
  const alt =
    mode === "tree" ? (
      <ResultTreeView {...viewProps} />
    ) : mode === "text" ? (
      <ResultTextView {...viewProps} />
    ) : null;

  const highlight = findMatchesState.lookup
    ? { has: findMatchesState.lookup, current: findMatchesState.current }
    : undefined;

  return {
    toolbar,
    options,
    bars,
    strip,
    side,
    alt,
    mode,
    transposed: a.transposed,
    highlight,
    onSelectionChange: setSel,
  };
}
