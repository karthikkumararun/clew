import { forwardRef, useEffect, useImperativeHandle } from "react";
import { lookOf } from "./cellStyle";
import type { GridHandle, ResultGridProps } from "./ResultGrid";
import { visibleColumns } from "./views";

/**
 * A DOM stand-in for the canvas `ResultGrid`, for tests of the screens around it: jsdom can't
 * paint a canvas, so cell text would otherwise be unreachable. It honours the same props.
 */
export const FakeResultGrid = forwardRef<GridHandle, ResultGridProps>(function FakeResultGrid(
  {
    source,
    onSort,
    hidden,
    order,
    onNearEnd,
    sort,
    onCellContext,
    headerDetail,
    keyColumns,
    onActivate,
    onSelectionChange,
    decorations,
  },
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
      select: () => {},
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
              {keyColumns?.has(c) ? "⚿ " : ""}
              {source.columns[c].name}
              {headerDetail ? <small> {headerDetail(c)}</small> : null}
            </button>
          ))}
        </div>
        {Array.from({ length: source.rowCount }, (_, r) => (
          <div
            key={r}
            role="row"
            data-marker={decorations?.row?.(r)?.marker}
            data-tint={decorations?.row?.(r)?.bg}
            onClick={() => onSelectionChange?.({ cols: cols.map((_, i) => i), rows: [r] })}
          >
            {cols.map((c) => (
              <div
                key={c}
                role="gridcell"
                data-cell={decorations?.cell?.(c, r)}
                onDoubleClick={() => onActivate?.(c, r)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onCellContext?.(cols.indexOf(c), r, e.clientX, e.clientY);
                }}
              >
                {lookOf(source.get(c, r)).text}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
});
