import { useCallback, useEffect, useMemo, useState } from "react";
import type { GridSource } from "./source";
import { TransposedSource, nextSort, visibleColumns } from "./views";
import type { SortState } from "./views";
import { VisibleSource, buildVisible, isIdentitySpec, mapToStoreRow } from "./tools/visibleRows";
import type { VisibleRows } from "./tools/visibleRows";
import type { ColumnFilter } from "./tools/localFilter";

export interface GridViewOptions {
  /** Narrow to rows containing this text (empty: all rows). */
  filter?: string;
  transposed?: boolean;
  /** Sort the loaded rows in the client. Off when the database sorts. */
  clientSort?: boolean;
  /** Changes when a different result arrives, which resets sort, columns and widths. */
  resetKey: string;
  /**
   * Rows before this index are loaded rows; later ones are rows the user inserted, which stay at
   * the end whatever the sort or filter. Default: every row is a loaded row.
   */
  loadedRows?: number;
  /**
   * What the sort and filters are recomputed on. The default (the source's own version) is right
   * for plain results; an editable result passes a key that does not change with each edit, so
   * editing a cell does not move the row (or hide it) while the user is working on it.
   */
  indexKey?: string | number;
}

/**
 * The user's view of a result: sort, per-column local filters, hidden / reordered / resized
 * columns, text filter and transpose, applied on top of the raw source without touching it. Sort
 * and filters share one `visible` index of store rows, so edits and pending changes (which are
 * keyed by store row) are never lost when a row is hidden.
 */
export function useGridView(base: GridSource, opts: GridViewOptions) {
  const { filter = "", transposed = false, clientSort = true, resetKey } = opts;
  const [sort, setSort] = useState<SortState | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [order, setOrder] = useState<number[]>([]);
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [columnFilters, setColumnFilters] = useState<ColumnFilter[]>([]);

  useEffect(() => {
    setSort(null);
    setHidden(new Set());
    setOrder([]);
    setWidths({});
    setColumnFilters([]);
  }, [resetKey]);

  const loadedRows = opts.loadedRows;
  const key = opts.indexKey ?? base.version;
  const visible: VisibleRows | null = useMemo(() => {
    const spec = {
      filters: columnFilters,
      text: filter,
      sort: clientSort ? sort : null,
      loadedRows,
    };
    return isIdentitySpec(spec) ? null : buildVisible(base, spec);
    // `rowCount` / `key`: the source grows in place while rows stream in
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, base.rowCount, key, columnFilters, filter, sort, clientSort, loadedRows]);

  const sorted = useMemo(
    () => (visible ? new VisibleSource(base, visible) : base),
    [base, visible],
  );
  const view = useMemo(
    () => (transposed ? new TransposedSource(sorted) : sorted),
    [sorted, transposed],
  );

  const onSort = useCallback((column: number) => setSort((cur) => nextSort(cur, column)), []);
  const toggleColumn = useCallback(
    (column: number) =>
      setHidden((cur) => {
        const next = new Set(cur);
        if (!next.delete(column)) next.add(column);
        return next;
      }),
    [],
  );
  const showAll = useCallback(() => setHidden(new Set()), []);
  /** Reset view: no sort, no filters, every column, default order and widths. */
  const resetView = useCallback(() => {
    setSort(null);
    setColumnFilters([]);
    setHidden(new Set());
    setOrder([]);
    setWidths({});
  }, []);
  /** The store row (what edits and the change set use) behind a displayed row. */
  const toStoreRow = useCallback(
    (displayRow: number) => mapToStoreRow(transposed ? null : visible, displayRow),
    [visible, transposed],
  );

  const shown = visibleColumns(base.columns.length, order, hidden).length;

  return {
    view,
    visible: transposed ? null : visible,
    toStoreRow,
    sort: transposed ? null : sort,
    setSort,
    onSort: transposed ? undefined : onSort,
    columnFilters,
    setColumnFilters,
    resetView,
    hidden,
    toggleColumn,
    showAll,
    order,
    setOrder,
    widths,
    setWidths,
    /** "Columns · 6 of 9" */
    shownColumns: shown,
    totalColumns: base.columns.length,
  };
}
