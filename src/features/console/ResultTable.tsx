import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef } from "react";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { valueColor, valueText } from "./valueFormat";
import styles from "./Console.module.css";

const ROW_HEIGHT = 26;
const MIN_WIDTH = 72;
const MAX_WIDTH = 360;
const CHAR_WIDTH = 7.4;
const ROWNUM_WIDTH = 52;

const NUMERIC = new Set(["int", "bigint", "float", "decimal"]);

export interface ResultTableProps {
  columns: ColumnMeta[];
  rows: Value[][];
  /** The server has more rows; scrolling to the end asks for them. */
  hasMore: boolean;
  fetching: boolean;
  onNearEnd: () => void;
  /** Offset for the row-number column (row numbers continue after a filter). */
  rowNumbers?: number[];
}

/** A read-only virtualized table. `add-data-grid` replaces it with the full grid. */
export function ResultTable({
  columns,
  rows,
  hasMore,
  fetching,
  onNearEnd,
  rowNumbers,
}: ResultTableProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 20,
  });

  const widths = useMemo(
    () =>
      columns.map((c, i) => {
        let longest = c.name.length + c.type_name.length + 2;
        for (let r = 0; r < Math.min(rows.length, 100); r++) {
          const t = valueText(rows[r][i]);
          if (t && t.length > longest) longest = t.length;
        }
        return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.ceil(longest * CHAR_WIDTH) + 24));
      }),
    [columns, rows],
  );
  const total = ROWNUM_WIDTH + widths.reduce((a, b) => a + b, 0);

  const items = virtualizer.getVirtualItems();
  const lastIndex = items.length ? items[items.length - 1].index : -1;
  // Reaching the last loaded rows asks for the next page.
  useEffect(() => {
    if (hasMore && !fetching && rows.length > 0 && lastIndex >= rows.length - 5) onNearEnd();
  }, [hasMore, fetching, rows.length, lastIndex, onNearEnd]);

  const template = `${ROWNUM_WIDTH}px ${widths.map((w) => `${w}px`).join(" ")}`;

  return (
    <div ref={scroller} className={styles.tableScroll} role="region" aria-label="Query result">
      <div
        role="grid"
        className={styles.table}
        style={{ width: total }}
        aria-rowcount={rows.length + 1}
        aria-colcount={columns.length + 1}
      >
        <div role="rowgroup" className={styles.thead}>
          <div role="row" className={styles.tr} style={{ gridTemplateColumns: template }}>
            <div role="columnheader" aria-label="Row" className={styles.rowNum} />
            {columns.map((c, i) => (
              <div
                key={i}
                role="columnheader"
                className={styles.th}
                data-numeric={NUMERIC.has(c.kind) || undefined}
                title={`${c.name} · ${c.type_name}`}
              >
                {c.name} <span className={styles.colType}>{c.type_name}</span>
              </div>
            ))}
          </div>
        </div>
        <div
          role="rowgroup"
          className={styles.tbody}
          style={{ height: virtualizer.getTotalSize() }}
        >
          {items.map((v) => {
            const row = rows[v.index];
            return (
              <div
                key={v.index}
                role="row"
                aria-rowindex={v.index + 2}
                className={`${styles.tr} ${styles.bodyRow}`}
                style={{ gridTemplateColumns: template, transform: `translateY(${v.start}px)` }}
              >
                <div role="rowheader" className={styles.rowNum}>
                  {rowNumbers ? rowNumbers[v.index] : v.index + 1}
                </div>
                {row.map((cell, i) => {
                  const text = valueText(cell);
                  return (
                    <div
                      key={i}
                      role="gridcell"
                      className={styles.td}
                      data-numeric={NUMERIC.has(cell.kind) || undefined}
                      style={{ color: valueColor(cell) }}
                      title={text ?? "NULL"}
                    >
                      {text === null ? <span className={styles.nullCell}>NULL</span> : text}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
      {fetching ? <div className={styles.fetching}>Loading more rows…</div> : null}
    </div>
  );
}
