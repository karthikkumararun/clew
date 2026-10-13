/**
 * Contract: aggregates of a cell selection (spec: data-grid › Aggregate view).
 * int, bigint and decimal cells are summed as a BigInt on a scaled integer (the longest
 * fraction digits seen, at least the column type's scale), so decimals never touch floating
 * point: 1150.00 + 300.00 = 1450.00 and 0.1 + 0.2 = 0.3. float cells use doubles and set
 * `approximate`. Non-numeric selections still give count, distinct, nulls and min/max in text
 * order. `Accumulator` is the worker-safe core (no DOM, no React); `aggregateAsync` feeds it in
 * chunks and yields between them, which is the path for selections over 100,000 cells.
 */
import type { Value } from "../../../lib/ipc/drivers";
import { valueText } from "../../console/valueFormat";
import {
  compareDecimal,
  decimalToString,
  divideRound,
  groupDecimalText,
  numericOf,
  rescale,
  trimScale,
} from "./decimal";
import type { Decimal } from "./decimal";

/** Selections larger than this go through `aggregateAsync`'s chunked path. */
export const ASYNC_THRESHOLD = 100_000;
/** Extra fraction digits an average may need beyond the data's scale. */
const AVG_EXTRA_DIGITS = 6;

export interface AggregateResult {
  /** Selected cells, including NULLs. */
  count: number;
  nullCount: number;
  /** Distinct non-NULL values (by their text). */
  distinct: number;
  /** Cells that took part in the numeric aggregates. */
  numericCount: number;
  /** Plain decimal text (no grouping); null when there are no numeric cells. */
  sum: string | null;
  avg: string | null;
  min: string | null;
  max: string | null;
  /** A float was involved: the numbers are doubles, not exact. */
  approximate: boolean;
  /** Smallest / largest non-NULL cell in text order (works for any kind). */
  minText: string | null;
  maxText: string | null;
}

export interface AggregateOptions {
  /** Scale declared by the column type (see `scaleFromTypeName`); results show at least this many digits. */
  scale?: number;
}

/** Incremental aggregator: `add` cells in any number of batches, then read `result()`. */
export class Accumulator {
  private count = 0;
  private nulls = 0;
  private seen = new Set<string>();
  private minText: string | null = null;
  private maxText: string | null = null;

  private exactN = 0;
  private sumInt = 0n;
  private scale: number;
  private minD: Decimal | null = null;
  private maxD: Decimal | null = null;

  private floatN = 0;
  private sumF = 0;
  private minF = Infinity;
  private maxF = -Infinity;

  constructor(opts: AggregateOptions = {}) {
    this.scale = Math.max(0, opts.scale ?? 0);
  }

  add(v: Value): void {
    this.count++;
    if (v.kind === "null") {
      this.nulls++;
      return;
    }
    const text = valueText(v) ?? "";
    this.seen.add(text);
    if (this.minText === null || text < this.minText) this.minText = text;
    if (this.maxText === null || text > this.maxText) this.maxText = text;
    const n = numericOf(v);
    if (!n) return;
    if ("float" in n) {
      this.floatN++;
      this.sumF += n.float;
      this.minF = Math.min(this.minF, n.float);
      this.maxF = Math.max(this.maxF, n.float);
      return;
    }
    const d = n.exact;
    if (d.scale > this.scale) {
      this.sumInt *= 10n ** BigInt(d.scale - this.scale);
      this.scale = d.scale;
    }
    this.sumInt += rescale(d, this.scale).int;
    this.exactN++;
    if (!this.minD || compareDecimal(d, this.minD) < 0) this.minD = d;
    if (!this.maxD || compareDecimal(d, this.maxD) > 0) this.maxD = d;
    return;
  }

  result(): AggregateResult {
    const numericCount = this.exactN + this.floatN;
    const base = {
      count: this.count,
      nullCount: this.nulls,
      distinct: this.seen.size,
      numericCount,
      minText: this.minText,
      maxText: this.maxText,
    };
    if (numericCount === 0) {
      return { ...base, sum: null, avg: null, min: null, max: null, approximate: false };
    }
    if (this.floatN > 0) {
      const exactSum = Number(decimalToString({ int: this.sumInt, scale: this.scale }));
      const sum = exactSum + this.sumF;
      const lows = [this.minF, ...(this.minD ? [Number(decimalToString(this.minD))] : [])];
      const highs = [this.maxF, ...(this.maxD ? [Number(decimalToString(this.maxD))] : [])];
      return {
        ...base,
        sum: doubleText(sum),
        avg: doubleText(sum / numericCount),
        min: doubleText(Math.min(...lows)),
        max: doubleText(Math.max(...highs)),
        approximate: true,
      };
    }
    const sum: Decimal = { int: this.sumInt, scale: this.scale };
    const avg = trimScale(
      divideRound(sum, BigInt(this.exactN), this.scale + AVG_EXTRA_DIGITS),
      this.scale,
    );
    return {
      ...base,
      sum: decimalToString(sum),
      avg: decimalToString(avg),
      min: decimalToString(rescale(this.minD as Decimal, this.scale)),
      max: decimalToString(rescale(this.maxD as Decimal, this.scale)),
      approximate: false,
    };
  }
}

/** A double as plain text with float noise (0.1 + 0.2) trimmed to 15 significant digits. */
function doubleText(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const t = Number(n.toPrecision(15));
  const s = String(t);
  if (!/e/i.test(s)) return s;
  const d = Math.abs(t) < 1 ? 20 : 0;
  return t.toFixed(d).replace(/\.?0+$/, "") || "0";
}

/** Aggregate a selection synchronously (fine up to `ASYNC_THRESHOLD` cells). */
export function aggregate(cells: Iterable<Value>, opts: AggregateOptions = {}): AggregateResult {
  const acc = new Accumulator(opts);
  for (const v of cells) acc.add(v);
  return acc.result();
}

export interface AsyncAggregateOptions extends AggregateOptions {
  /** Cells per chunk between yields (default 20,000). */
  chunk?: number;
  /** Called between chunks so the UI stays responsive; default is a macrotask. */
  yieldNow?: () => Promise<void>;
  signal?: AbortSignal;
  onProgress?: (done: number) => void;
}

const macrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** Aggregate in chunks, yielding between them; rejects with an AbortError when cancelled. */
export async function aggregateAsync(
  cells: Iterable<Value>,
  opts: AsyncAggregateOptions = {},
): Promise<AggregateResult> {
  const { chunk = 20_000, yieldNow = macrotask, signal, onProgress } = opts;
  const acc = new Accumulator(opts);
  let done = 0;
  for (const v of cells) {
    acc.add(v);
    if (++done % chunk === 0) {
      onProgress?.(done);
      await yieldNow();
      if (signal?.aborted) throw abortError();
    }
  }
  if (signal?.aborted) throw abortError();
  onProgress?.(done);
  return acc.result();
}

function abortError(): Error {
  const e = new Error("Aggregate cancelled");
  e.name = "AbortError";
  return e;
}

/** Pick the path by size: small selections resolve immediately, large ones are chunked. */
export function aggregateSelection(
  cells: Iterable<Value>,
  cellCount: number,
  opts: AsyncAggregateOptions = {},
): Promise<AggregateResult> {
  return cellCount > ASYNC_THRESHOLD
    ? aggregateAsync(cells, opts)
    : Promise.resolve(aggregate(cells, opts));
}

export interface FormatOptions {
  /** Group thousands ("1,450.00"), as the grid's number format does. Default true. */
  group?: boolean;
  /** Also show distinct, NULL count and text min/max. */
  extended?: boolean;
}

export interface AggregateItem {
  label: string;
  text: string;
}

const num = (s: string | null, group: boolean) =>
  s === null ? "" : group ? groupDecimalText(s) : s;

/**
 * The strip's items: "N cells", then COUNT, SUM, AVG, MIN, MAX when numeric cells are among the
 * selection (labelled approximate for floats). Text-only selections show the cell count only,
 * unless `extended`.
 */
export function aggregateItems(r: AggregateResult, o: FormatOptions = {}): AggregateItem[] {
  const group = o.group ?? true;
  const approx = r.approximate ? "≈ " : "";
  const items: AggregateItem[] = [
    { label: r.count === 1 ? "cell" : "cells", text: String(r.count) },
  ];
  if (r.numericCount > 0) {
    items.push(
      { label: "COUNT", text: String(r.numericCount) },
      { label: "SUM", text: approx + num(r.sum, group) },
      { label: "AVG", text: approx + num(r.avg, group) },
      { label: "MIN", text: approx + num(r.min, group) },
      { label: "MAX", text: approx + num(r.max, group) },
    );
  }
  if (o.extended) {
    items.push(
      { label: "DISTINCT", text: String(r.distinct) },
      { label: "NULLS", text: String(r.nullCount) },
    );
    if (r.numericCount === 0 && r.minText !== null) {
      items.push({ label: "MIN", text: r.minText }, { label: "MAX", text: r.maxText ?? "" });
    }
  }
  return items;
}

/** "2 cells · COUNT 2 · SUM 1,450.00 · …" for the strip's text and tooltips. */
export function formatAggregate(r: AggregateResult, o: FormatOptions = {}): string {
  return aggregateItems(r, o)
    .map((i, n) => (n === 0 ? `${i.text} ${i.label}` : `${i.label} ${i.text}`))
    .join(" · ");
}

/** What Mod+Shift+C copies: the SUM (unformatted by default); null when nothing is numeric. */
export function aggregateClipboardText(r: AggregateResult, o: FormatOptions = {}): string | null {
  if (r.sum === null) return null;
  return num(r.sum, o.group ?? false);
}
