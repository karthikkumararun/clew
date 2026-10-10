import { useCallback, useEffect, useMemo, useState } from "react";
import type { GridSource } from "./source";
import { FilteredSource, SortedSource, TransposedSource, nextSort, visibleColumns } from "./views";
import type { SortState } from "./views";

export interface GridViewOptions {
  /** Narrow to rows containing this text (empty: all rows). */
  filter?: string;
  transposed?: boolean;
  /** Sort the loaded rows in the client. Off when the database sorts. */
  clientSort?: boolean;
  /** Changes when a different result arrives, which resets sort, columns and widths. */
  resetKey: string;
}

/**
 * The user's view of a result: sort, hidden / reordered / resized columns, filter and transpose,
 * applied on top of the raw source without touching it.
 */
export function useGridView(base: GridSource, opts: GridViewOptions) {
  const { filter = "", transposed = false, clientSort = true, resetKey } = opts;
  const [sort, setSort] = useState<SortState | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<number>>(new Set());
  const [order, setOrder] = useState<number[]>([]);
  const [widths, setWidths] = useState<Record<number, number>>({});

  useEffect(() => {
    setSort(null);
    setHidden(new Set());
    setOrder([]);
    setWidths({});
  }, [resetKey]);

  const filtered = useMemo(
    () => (filter.trim() ? new FilteredSource(base, filter) : base),
    // `rowCount` / `version`: the source grows in place while rows stream in
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, filter, base.rowCount, base.version],
  );
  const sorted = useMemo(
    () => (clientSort && sort ? new SortedSource(filtered, sort) : filtered),
    [filtered, sort, clientSort],
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

  const shown = visibleColumns(base.columns.length, order, hidden).length;

  return {
    view,
    sort: transposed ? null : sort,
    setSort,
    onSort: transposed ? undefined : onSort,
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
