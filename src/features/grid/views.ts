import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { valueText } from "../console/valueFormat";
import type { GridSource } from "./source";

export type SortDir = "asc" | "desc";
export interface SortState {
  /** Source column index. */
  column: number;
  dir: SortDir;
}

/** The header-click cycle: ascending, then descending, then unsorted. */
export function nextSort(current: SortState | null, column: number): SortState | null {
  if (!current || current.column !== column) return { column, dir: "asc" };
  return current.dir === "asc" ? { column, dir: "desc" } : null;
}

const NUMERIC = new Set<Value["kind"]>(["int", "bigint", "float", "decimal"]);

function compareValues(a: Value, b: Value): number {
  if (a.kind === "null" || b.kind === "null") {
    return a.kind === b.kind ? 0 : a.kind === "null" ? 1 : -1; // NULLs sort last
  }
  if (NUMERIC.has(a.kind) && NUMERIC.has(b.kind)) {
    const x = Number((a as { value: number | string }).value);
    const y = Number((b as { value: number | string }).value);
    if (x !== y && !Number.isNaN(x) && !Number.isNaN(y)) return x < y ? -1 : 1;
    if (x === y && a.kind !== "bigint" && b.kind !== "bigint") return 0;
    // Beyond 2^53 compare the digits exactly.
    try {
      const bx = BigInt((a as { value: number | string }).value);
      const by = BigInt((b as { value: number | string }).value);
      return bx < by ? -1 : bx > by ? 1 : 0;
    } catch {
      return 0;
    }
  }
  if (a.kind === "bool" && b.kind === "bool") return Number(a.value) - Number(b.value);
  const x = textOf(a);
  const y = textOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function textOf(v: Value): string {
  return typeof (v as { value?: unknown }).value === "string"
    ? (v as { value: string }).value
    : JSON.stringify((v as { value?: unknown }).value ?? "");
}

/** A sorted view of loaded rows: stable, NULLs last in either direction. */
export class SortedSource implements GridSource {
  private order: Uint32Array;

  constructor(
    private inner: GridSource,
    sort: SortState,
  ) {
    const n = inner.rowCount;
    const idx = Array.from({ length: n }, (_, i) => i);
    const sign = sort.dir === "asc" ? 1 : -1;
    idx.sort((a, b) => {
      const x = inner.get(sort.column, a);
      const y = inner.get(sort.column, b);
      // Keep NULLs at the end whichever way we sort.
      if (x.kind === "null" || y.kind === "null") return compareValues(x, y);
      return sign * compareValues(x, y) || a - b;
    });
    this.order = Uint32Array.from(idx);
  }

  get columns(): ColumnMeta[] {
    return this.inner.columns;
  }
  get rowCount(): number {
    return this.order.length;
  }
  get version(): number {
    return this.inner.version;
  }
  get(col: number, row: number): Value {
    return this.inner.get(col, this.order[row] ?? row);
  }
  /** The row of the unsorted source behind a displayed row. */
  sourceRow(row: number): number {
    return this.order[row] ?? row;
  }
}

/** A view of the loaded rows that contain the text (case-insensitive substring over every cell). */
export class FilteredSource implements GridSource {
  private rows: Uint32Array;

  constructor(
    private inner: GridSource,
    needle: string,
  ) {
    const q = needle.trim().toLowerCase();
    const hits: number[] = [];
    for (let r = 0; r < inner.rowCount; r++) {
      for (let c = 0; c < inner.columns.length; c++) {
        if (valueText(inner.get(c, r))?.toLowerCase().includes(q)) {
          hits.push(r);
          break;
        }
      }
    }
    this.rows = Uint32Array.from(hits);
  }

  get columns(): ColumnMeta[] {
    return this.inner.columns;
  }
  get rowCount(): number {
    return this.rows.length;
  }
  get version(): number {
    return this.inner.version;
  }
  get(col: number, row: number): Value {
    return this.inner.get(col, this.rows[row] ?? row);
  }
}

/** Rows become columns: one line per column, one value column per (first) row. */
export class TransposedSource implements GridSource {
  readonly columns: ColumnMeta[];

  constructor(
    private inner: GridSource,
    limit = 50,
  ) {
    const shown = Math.min(inner.rowCount, limit);
    this.columns = [
      { name: "column", type_name: "", kind: "text", nullable: false },
      ...Array.from({ length: shown }, (_, i) => ({
        name: shown === 1 ? "value" : `#${i + 1}`,
        type_name: "",
        kind: "text" as const,
        nullable: null,
      })),
    ];
  }

  get rowCount(): number {
    return this.inner.columns.length;
  }
  get version(): number {
    return this.inner.version;
  }
  get(col: number, row: number): Value {
    if (col === 0) return { kind: "text", value: this.inner.columns[row]?.name ?? "" };
    return this.inner.get(row, col - 1);
  }
}

/** Column indexes in display order, without the hidden ones. */
export function visibleColumns(
  count: number,
  order: number[],
  hidden: ReadonlySet<number>,
): number[] {
  const seen = new Set<number>();
  const ordered: number[] = [];
  for (const c of order) {
    if (c >= 0 && c < count && !seen.has(c)) {
      seen.add(c);
      ordered.push(c);
    }
  }
  for (let c = 0; c < count; c++) if (!seen.has(c)) ordered.push(c);
  return ordered.filter((c) => !hidden.has(c));
}

/** Move a displayed column, returning the new order of the visible columns. */
export function moveColumn(visible: number[], from: number, to: number): number[] {
  const next = [...visible];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
