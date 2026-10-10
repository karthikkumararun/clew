import type { ColumnMeta, Value } from "../../lib/ipc/drivers";

/** What the grid reads: columns, a row count and O(1) cell lookup. */
export interface GridSource {
  readonly columns: ColumnMeta[];
  readonly rowCount: number;
  get(col: number, row: number): Value;
  /** Changes whenever rows are appended or replaced, so views know to repaint. */
  readonly version: number;
}

/** One page of rows, stored by column. */
interface Batch {
  /** First row of the batch in the whole result. */
  start: number;
  size: number;
  cols: Value[][];
}

/**
 * Rows held as column-major batches: appending a page is O(page) and `get` is a batch lookup
 * (remembering the last batch hit, so sequential reads never search) plus two array indexes.
 */
export class ColumnarStore implements GridSource {
  private batches: Batch[] = [];
  private rows = 0;
  private hit = 0;
  version = 0;

  constructor(public columns: ColumnMeta[] = []) {}

  get rowCount(): number {
    return this.rows;
  }

  /** Start over with new columns (a different query). */
  reset(columns: ColumnMeta[]): void {
    this.columns = columns;
    this.batches = [];
    this.rows = 0;
    this.hit = 0;
    this.version++;
  }

  /** Add a page of rows after the ones already held. */
  append(rows: Value[][]): void {
    if (rows.length === 0) return;
    const n = this.columns.length;
    const cols: Value[][] = Array.from({ length: n }, () => new Array<Value>(rows.length));
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r];
      for (let c = 0; c < n; c++) cols[c][r] = row[c];
    }
    this.batches.push({ start: this.rows, size: rows.length, cols });
    this.rows += rows.length;
    this.version++;
  }

  /** Replace everything with one page (the table editor's paging). */
  replace(rows: Value[][]): void {
    this.batches = [];
    this.rows = 0;
    this.hit = 0;
    this.append(rows);
    this.version++;
  }

  private batchFor(row: number): Batch | undefined {
    const cur = this.batches[this.hit];
    if (cur && row >= cur.start && row < cur.start + cur.size) return cur;
    let lo = 0;
    let hi = this.batches.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const b = this.batches[mid];
      if (row < b.start) hi = mid - 1;
      else if (row >= b.start + b.size) lo = mid + 1;
      else {
        this.hit = mid;
        return b;
      }
    }
    return undefined;
  }

  get(col: number, row: number): Value {
    const b = this.batchFor(row);
    return b?.cols[col]?.[row - b.start] ?? NULL;
  }

  /** Overwrite one cell (a committed edit, before the page reloads). */
  set(col: number, row: number, value: Value): void {
    const b = this.batchFor(row);
    if (b?.cols[col]) {
      b.cols[col][row - b.start] = value;
      this.version++;
    }
  }

  /** The loaded row as an array, e.g. for copy and the record panel. */
  row(row: number): Value[] {
    return this.columns.map((_, c) => this.get(c, row));
  }
}

const NULL: Value = { kind: "null" };

/** Adapts a row-major result that grows in place (the console's streamed rows). */
export class RowsSource implements GridSource {
  constructor(
    public columns: ColumnMeta[],
    private rows: Value[][],
    public version = 0,
  ) {}

  /** Point at the (possibly longer) rows of the same result. */
  update(columns: ColumnMeta[], rows: Value[][], version: number): void {
    this.columns = columns;
    this.rows = rows;
    this.version = version;
  }

  get rowCount(): number {
    return this.rows.length;
  }

  get(col: number, row: number): Value {
    return this.rows[row]?.[col] ?? NULL;
  }
}

/** A source of a few explicit rows, for transposed views and tests. */
export function sourceOf(columns: ColumnMeta[], rows: Value[][]): GridSource {
  return new RowsSource(columns, rows);
}
