/**
 * Contract: the `visibleRows` index that find, local filter and sort share (design: Find,
 * local filter, view as). It is an array of STORE row indexes in display order; display row `i`
 * shows store row `visible[i]`. Edits, the pending bar and `ChangeSet` keep working on store
 * rows, so hiding a row never loses its changes. Rows at or past `loadedRows` (inserted rows)
 * are never filtered or sorted and stay at the end. `null` means "identity, nothing hidden".
 * Pure; `VisibleSource` is the only class and replaces FilteredSource and SortedSource.
 */
import type { Value } from "../../../lib/ipc/drivers";
import { valueText } from "../../console/valueFormat";
import type { ColumnMeta } from "../../../lib/ipc/drivers";
import type { GridSource } from "../source";
import type { SortState } from "../views";
import { compareNumeric, numericOf } from "./decimal";
import { filterRows } from "./localFilter";
import type { ColumnFilter } from "./localFilter";

export type VisibleRows = Uint32Array;

export interface VisibleSpec {
  /** Per-column local filters (AND). */
  filters?: readonly ColumnFilter[];
  /** The quick text filter: rows where any cell contains the text, case-insensitive. */
  text?: string;
  sort?: SortState | null;
  /** Rows before this are the loaded rows; later ones are inserted rows. Default: all rows. */
  loadedRows?: number;
}

/** True when the spec hides or reorders nothing, so callers can skip the index entirely. */
export function isIdentitySpec(spec: VisibleSpec): boolean {
  return !spec.filters?.length && !spec.text?.trim() && !spec.sort;
}

export function identityRows(count: number): VisibleRows {
  const out = new Uint32Array(count);
  for (let i = 0; i < count; i++) out[i] = i;
  return out;
}

/** Compare two cells: exact for numbers, NULLs last, then bool, then text order. */
export function compareCells(a: Value, b: Value): number {
  if (a.kind === "null" || b.kind === "null") {
    return a.kind === b.kind ? 0 : a.kind === "null" ? 1 : -1;
  }
  const x = numericOf(a);
  const y = numericOf(b);
  if (x && y) return compareNumeric(x, y);
  if (a.kind === "bool" && b.kind === "bool") return Number(a.value) - Number(b.value);
  const s = valueText(a) ?? "";
  const t = valueText(b) ?? "";
  return s < t ? -1 : s > t ? 1 : 0;
}

/** Build the display-order index: filter, then sort (stable, NULLs last either way). */
export function buildVisible(source: GridSource, spec: VisibleSpec = {}): VisibleRows {
  const total = source.rowCount;
  const loaded = Math.min(spec.loadedRows ?? total, total);
  let rows: ArrayLike<number> = identityRows(loaded);

  if (spec.filters?.length) rows = filterRows(source, spec.filters, { candidates: rows });
  const needle = spec.text?.trim().toLowerCase();
  if (needle) {
    const hits: number[] = [];
    const cols = source.columns.length;
    for (let i = 0; i < rows.length; i++) {
      for (let c = 0; c < cols; c++) {
        if (valueText(source.get(c, rows[i]))?.toLowerCase().includes(needle)) {
          hits.push(rows[i]);
          break;
        }
      }
    }
    rows = hits;
  }
  let order = Array.from(rows);
  if (spec.sort) {
    const { column, dir } = spec.sort;
    const sign = dir === "asc" ? 1 : -1;
    order.sort((a, b) => {
      const x = source.get(column, a);
      const y = source.get(column, b);
      if (x.kind === "null" || y.kind === "null") return compareCells(x, y);
      return sign * compareCells(x, y) || a - b;
    });
  }
  if (loaded < total)
    order = order.concat(Array.from({ length: total - loaded }, (_, i) => loaded + i));
  return Uint32Array.from(order);
}

/** Display row to store row (identity when there is no index or the row is out of range). */
export function mapToStoreRow(visible: ArrayLike<number> | null, displayRow: number): number {
  return visible ? (visible[displayRow] ?? displayRow) : displayRow;
}

/** Store row to display row, or -1 when the row is hidden. Build `inverseIndex` for bulk use. */
export function displayRowOf(visible: ArrayLike<number> | null, storeRow: number): number {
  if (!visible) return storeRow;
  for (let i = 0; i < visible.length; i++) if (visible[i] === storeRow) return i;
  return -1;
}

/** Store row to display row for every store row, -1 where hidden. */
export function inverseIndex(visible: ArrayLike<number>, totalRows: number): Int32Array {
  const inv = new Int32Array(totalRows).fill(-1);
  for (let i = 0; i < visible.length; i++) if (visible[i] < totalRows) inv[visible[i]] = i;
  return inv;
}

/** A source whose rows are `visible` (store rows) of `inner`; cell reads map through the index. */
export class VisibleSource implements GridSource {
  constructor(
    private inner: GridSource,
    private visible: ArrayLike<number> | null,
  ) {}

  get columns(): ColumnMeta[] {
    return this.inner.columns;
  }
  get rowCount(): number {
    return this.visible ? this.visible.length : this.inner.rowCount;
  }
  get version(): number {
    return this.inner.version;
  }
  get(col: number, row: number): Value {
    return this.inner.get(col, mapToStoreRow(this.visible, row));
  }
  /** The store row behind a displayed row (what edits and the pending bar use). */
  sourceRow(row: number): number {
    return mapToStoreRow(this.visible, row);
  }
  /** Rows of the store the view hides (for "Showing n of m rows"). */
  get hiddenCount(): number {
    return this.visible ? Math.max(0, this.inner.rowCount - this.visible.length) : 0;
  }
}
