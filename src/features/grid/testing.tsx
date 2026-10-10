import { forwardRef, useEffect, useImperativeHandle } from "react";
import { lookOf } from "./cellStyle";
import type { GridHandle, ResultGridProps } from "./ResultGrid";
import { visibleColumns } from "./views";

/**
 * A DOM stand-in for the canvas `ResultGrid`, for tests of the screens around it: jsdom can't
 * paint a canvas, so cell text would otherwise be unreachable. It honours the same props.
 */
export const FakeResultGrid = forwardRef<GridHandle, ResultGridProps>(function FakeResultGrid(
  { source, onSort, hidden, order, onNearEnd, sort },
  ref,
) {
  // The few rows that fit always have their end in view.
  useEffect(() => {
    onNearEnd?.();
  }, [onNearEnd, source.rowCount]);
  const cols = visibleColumns(source.columns.length, order ?? [], hidden ?? new Set());
  useImperativeHandle(
    ref,
    () => ({
      selection: () => ({ cols: [], rows: [] }),
      selectedData: () => null,
      copyAs: async () => 0,
      openViewer: () => {},
      focus: () => {},
    }),
    [],
  );
  return (
    <div role="region" aria-label="Query result" data-testid="fake-grid">
      <div role="grid" aria-rowcount={source.rowCount + 1} aria-colcount={cols.length}>
        <div role="row">
          {cols.map((c) => (
            <button
              key={c}
              type="button"
              role="columnheader"
              aria-sort={
                sort?.column === c ? (sort.dir === "asc" ? "ascending" : "descending") : "none"
              }
              onClick={() => onSort?.(c)}
            >
              {source.columns[c].name}
            </button>
          ))}
        </div>
        {Array.from({ length: source.rowCount }, (_, r) => (
          <div key={r} role="row">
            {cols.map((c) => (
              <div key={c} role="gridcell">
                {lookOf(source.get(c, r)).text}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});
