/**
 * Contract: the aggregate strip under the grid (spec: data-grid › Aggregate view).
 *
 * Props:
 *  - `count`: selected cells. Fewer than 2 renders nothing (spec: "more than one cell").
 *  - `getCells`: lazily yields the selected cells; called only when the strip recomputes.
 *  - `selectionKey`: anything that changes when the selected cells' content changes (selection
 *    rectangle, source version, edits). The strip recomputes on `count` / `selectionKey` /
 *    `columnTypeName` changes, never on parent re-render alone, so `getCells` need not be stable.
 *  - `columnTypeName`: type of the selected column, so decimals show at least the declared scale.
 *  - `extended`: also show DISTINCT / NULLS (and text MIN / MAX for non-numeric selections).
 *  - `onResult`: the latest result (null while computing or hidden); feed it to
 *    `aggregateClipboardText` for `registerAggregateShortcut`.
 * Selections over ASYNC_THRESHOLD cells use the chunked path with a progress spinner, and a
 * newer selection aborts the stale computation. role="status", name "Selection aggregate".
 */
import { useEffect, useRef, useState } from "react";
import type { Value } from "../../../../lib/ipc/drivers";
import {
  ASYNC_THRESHOLD,
  aggregate,
  aggregateAsync,
  aggregateClipboardText,
  aggregateItems,
  formatAggregate,
} from "../aggregate";
import type { AggregateResult } from "../aggregate";
import { scaleFromTypeName } from "../decimal";
import { copyAggregateText } from "./aggregateShortcut";
import styles from "./tools.module.css";

export interface AggregateStripProps {
  count: number;
  getCells: () => Iterable<Value>;
  selectionKey?: unknown;
  columnTypeName?: string;
  extended?: boolean;
  onResult?: (result: AggregateResult | null) => void;
}

export function AggregateStrip({
  count,
  getCells,
  selectionKey,
  columnTypeName,
  extended,
  onResult,
}: AggregateStripProps) {
  const [result, setResult] = useState<AggregateResult | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const cellsRef = useRef(getCells);
  cellsRef.current = getCells;
  const reportRef = useRef(onResult);
  reportRef.current = onResult;
  const active = count > 1;

  useEffect(() => {
    if (!active) {
      setResult(null);
      setProgress(null);
      reportRef.current?.(null);
      return;
    }
    const ctl = new AbortController();
    const big = count > ASYNC_THRESHOLD;
    if (big) {
      setResult(null);
      setProgress(0);
      reportRef.current?.(null);
    }
    const scale = (columnTypeName && scaleFromTypeName(columnTypeName)) || undefined;
    const opts = { scale };
    const finish = (r: AggregateResult) => {
      setProgress(null);
      setResult(r);
      reportRef.current?.(r);
    };
    if (!big) {
      finish(aggregate(cellsRef.current(), opts));
      return;
    }
    aggregateAsync(cellsRef.current(), {
      ...opts,
      signal: ctl.signal,
      onProgress: (n) => !ctl.signal.aborted && setProgress(n),
    }).then(
      (r) => {
        if (!ctl.signal.aborted) finish(r);
      },
      (e: unknown) => {
        if (!(e instanceof Error && e.name === "AbortError")) throw e;
      },
    );
    return () => ctl.abort();
  }, [active, count, selectionKey, columnTypeName]);

  if (!active) return null;
  const sum = result ? aggregateClipboardText(result) : null;
  return (
    <div
      className={styles.strip}
      role="status"
      aria-label="Selection aggregate"
      aria-busy={progress !== null}
      title={result ? formatAggregate(result, { extended: true }) : undefined}
    >
      {progress !== null && (
        <span className={styles.progress}>
          <span className={styles.spinner} aria-hidden="true" />
          Calculating… {progress.toLocaleString("en-US")} of {count.toLocaleString("en-US")}
        </span>
      )}
      {result &&
        aggregateItems(result, { extended }).map((item, i) => (
          <span key={`${item.label}-${i}`} className={styles.item}>
            {i === 0 ? (
              <>
                <span className={styles.value}>{item.text}</span> {item.label}
              </>
            ) : (
              <>
                <span className={styles.label}>{item.label}</span>{" "}
                <span className={styles.value}>{item.text}</span>
              </>
            )}
          </span>
        ))}
      {result?.approximate && <span className={styles.approx}>approximate (float values)</span>}
      {sum !== null && (
        <button
          type="button"
          className={styles.link}
          aria-label="Copy sum"
          title="Copy sum (Mod+Shift+C)"
          onClick={() => void copyAggregateText(sum)}
        >
          Copy sum
        </button>
      )}
    </div>
  );
}
