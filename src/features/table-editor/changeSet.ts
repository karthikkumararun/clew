import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import type { ChangeRequest, NewValue } from "./api";
import type { NodePath } from "../../lib/ipc/drivers";
import type { GridSource } from "../grid/source";

export type RowState = "inserted" | "deleted" | "edited";

interface Snap {
  /** Edited cells of loaded rows: row → column → new value. */
  edits: Map<number, Map<number, NewValue>>;
  /** New rows; a column left out gets its DEFAULT. */
  inserts: Map<number, NewValue>[];
  /** Loaded rows marked for deletion. */
  deletes: Set<number>;
}

const empty = (): Snap => ({ edits: new Map(), inserts: [], deletes: new Set() });

const copy = (s: Snap): Snap => ({
  edits: new Map([...s.edits].map(([r, cells]) => [r, new Map(cells)])),
  inserts: s.inserts.map((m) => new Map(m)),
  deletes: new Set(s.deletes),
});

const DEFAULT_SHOWN: Value = { kind: "other", value: "DEFAULT", type_name: "default" };

const same = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

/**
 * How a result's columns map onto the table being edited (a query result in the console, not the
 * table editor itself; spec: result-editing › Editable query results). Absent for the table
 * editor, where result columns are the table's columns.
 */
export interface ChangeMapping {
  /** Per result column: the column of the edit table it writes to, or null when it is not editable. */
  columnMap: (string | null)[];
  /** Result column indexes that hold the edit table's key, in key order. */
  keyIndexes: number[];
}

export interface Counts {
  edited: number;
  inserted: number;
  deleted: number;
  total: number;
}

/**
 * Staged edits over a loaded page. It is itself a [`GridSource`]: loaded rows come first, with
 * edits applied, then the inserted rows. Nothing reaches the database until the edits are turned
 * into a [`ChangeRequest`] and submitted. Every change is an undo step.
 */
export class ChangeSet implements GridSource {
  private snap = empty();
  private past: Snap[] = [];
  private future: Snap[] = [];
  private rev = 0;
  private listeners = new Set<() => void>();

  constructor(
    private base: GridSource,
    private mapping?: ChangeMapping,
  ) {}

  /** Result rows by the key of the table row they show (shared rows); built per loaded version. */
  private keyIndex: { version: number; rows: Map<string, number[]> } | null = null;

  private keyString(row: number): string | null {
    const m = this.mapping;
    if (!m || m.keyIndexes.length === 0) return null;
    return JSON.stringify(m.keyIndexes.map((i) => this.base.get(i, row)));
  }

  /** Every loaded row that shows the same table row as `row`, including `row` itself. */
  sharedRows(row: number): number[] {
    if (row >= this.base.rowCount) return [row];
    const k = this.keyString(row);
    if (k === null) return [row];
    if (!this.keyIndex || this.keyIndex.version !== this.base.version) {
      const rows = new Map<string, number[]>();
      for (let r = 0; r < this.base.rowCount; r++) {
        const key = this.keyString(r);
        if (key === null) continue;
        const list = rows.get(key);
        if (list) list.push(r);
        else rows.set(key, [r]);
      }
      this.keyIndex = { version: this.base.version, rows };
    }
    return this.keyIndex.rows.get(k) ?? [row];
  }

  // --- GridSource ---------------------------------------------------------------------------

  get columns(): ColumnMeta[] {
    return this.base.columns;
  }
  get loadedRows(): number {
    return this.base.rowCount;
  }
  get rowCount(): number {
    return this.base.rowCount + this.snap.inserts.length;
  }
  get version(): number {
    return this.base.version * 1_000_003 + this.rev;
  }

  get(col: number, row: number): Value {
    const n = this.base.rowCount;
    if (row >= n) {
      const nv = this.snap.inserts[row - n]?.get(col);
      return nv ? shown(nv) : DEFAULT_SHOWN;
    }
    const nv = this.snap.edits.get(row)?.get(col);
    return nv ? shown(nv) : this.base.get(col, row);
  }

  /** The loaded value, ignoring edits. */
  original(col: number, row: number): Value {
    return this.base.get(col, row);
  }

  // --- subscription (useSyncExternalStore) ---------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnapshot = () => this.rev;
  private changed() {
    this.rev++;
    this.listeners.forEach((l) => l());
  }

  // --- state ---------------------------------------------------------------------------------

  rowState(row: number): RowState | undefined {
    const n = this.base.rowCount;
    if (row >= n) return "inserted";
    if (this.snap.deletes.has(row)) return "deleted";
    return this.snap.edits.has(row) ? "edited" : undefined;
  }

  /** The staged cells of a loaded row: column → new value. */
  editsOf(row: number): Map<number, NewValue> {
    return new Map(this.snap.edits.get(row) ?? []);
  }

  /** Drop the staged edits of a row and of every row that shows the same table row. */
  revertRow(row: number): void {
    const next = copy(this.snap);
    for (const r of this.sharedRows(row)) next.edits.delete(r);
    this.commit(next);
  }

  /** Whether the row has a staged edit (any cell). */
  isRowEdited(row: number): boolean {
    return this.snap.edits.has(row);
  }

  isEdited(col: number, row: number): boolean {
    return this.snap.edits.get(row)?.has(col) === true;
  }

  counts(): Counts {
    // Rows that show the same table row count once (spec: result-editing › Shared rows).
    const once = (rows: Iterable<number>) => {
      const seen = new Set<string>();
      let n = 0;
      for (const r of rows) {
        const k = this.keyString(r);
        if (k === null) n++;
        else if (!seen.has(k)) {
          seen.add(k);
          n++;
        }
      }
      return n;
    };
    const edited = once([...this.snap.edits.keys()].filter((r) => !this.snap.deletes.has(r)));
    const inserted = this.snap.inserts.length;
    const deleted = once(this.snap.deletes);
    return { edited, inserted, deleted, total: edited + inserted + deleted };
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  // --- changes -------------------------------------------------------------------------------

  /** Set while `group` runs: the undo depth it started at, so later commits add no snapshots. */
  private groupStart: number | null = null;

  /** The snapshot to edit: inside a group, after its first commit, the group's own copy. */
  private working(): Snap {
    return this.groupStart !== null && this.past.length > this.groupStart
      ? this.snap
      : copy(this.snap);
  }

  private commit(next: Snap) {
    // Inside a group only the first commit records the "before" snapshot (a 10,000 cell paste
    // would otherwise keep 10,000 snapshots alive until the group ends).
    if (this.groupStart === null || this.past.length === this.groupStart) this.past.push(this.snap);
    this.future = [];
    this.snap = next;
    this.changed();
  }

  /** Set a cell. Writing back the loaded value removes the edit. */
  setCell(row: number, col: number, value: NewValue): void {
    const n = this.base.rowCount;
    const next = this.working();
    if (row >= n) {
      const ins = next.inserts[row - n];
      if (!ins) return;
      ins.set(col, value);
    } else {
      if (next.deletes.has(row)) return;
      // An edit of a table row applies to every result row that shows it.
      for (const r of this.sharedRows(row)) {
        const cells = next.edits.get(r) ?? new Map<number, NewValue>();
        if (value.kind === "value" && same(value.value, this.base.get(col, r))) cells.delete(col);
        else cells.set(col, value);
        if (cells.size === 0) next.edits.delete(r);
        else next.edits.set(r, cells);
      }
    }
    this.commit(next);
  }

  /** Append an empty new row; returns its row index. */
  addRow(): number {
    const next = this.working();
    next.inserts.push(new Map());
    this.commit(next);
    return this.rowCount - 1;
  }

  /** Mark loaded rows deleted (or restore them when all are already marked); drop new rows. */
  deleteRows(rows: number[]): void {
    const n = this.base.rowCount;
    const next = copy(this.snap);
    const loaded = [...new Set(rows.filter((r) => r < n).flatMap((r) => this.sharedRows(r)))];
    const fresh = rows.filter((r) => r >= n).sort((a, b) => b - a);
    for (const r of fresh) next.inserts.splice(r - n, 1);
    const restore = loaded.length > 0 && loaded.every((r) => next.deletes.has(r));
    for (const r of loaded) {
      if (restore) next.deletes.delete(r);
      else next.deletes.add(r);
    }
    this.commit(next);
  }

  /**
   * Run several changes as one undo step: Mod+Z reverts all of them together (a paste is one
   * step, however many cells it sets).
   */
  group<T>(fn: () => T): T {
    const start = this.past.length;
    const outer = this.groupStart;
    this.groupStart = outer ?? start;
    try {
      const out = fn();
      if (this.past.length - start > 1) this.past.splice(start + 1);
      return out;
    } finally {
      this.groupStart = outer;
    }
  }

  /** How many undo steps are recorded (for callers that undo what they just staged). */
  get undoDepth(): number {
    return this.past.length;
  }

  undo(): boolean {
    const prev = this.past.pop();
    if (!prev) return false;
    this.future.push(this.snap);
    this.snap = prev;
    this.changed();
    return true;
  }

  redo(): boolean {
    const next = this.future.pop();
    if (!next) return false;
    this.past.push(this.snap);
    this.snap = next;
    this.changed();
    return true;
  }

  /** Drop every pending change (and the undo history). */
  clear(): void {
    if (this.counts().total === 0 && this.past.length === 0 && this.future.length === 0) return;
    this.snap = empty();
    this.past = [];
    this.future = [];
    this.changed();
  }

  // --- submit --------------------------------------------------------------------------------

  private editedRows(): number[] {
    return [...this.snap.edits.keys()]
      .filter((r) => !this.snap.deletes.has(r))
      .sort((a, b) => a - b);
  }
  private deletedRows(): number[] {
    return [...this.snap.deletes].sort((a, b) => a - b);
  }

  /** One row per table row: result rows that share a key are one statement. */
  private firstOfKey(rows: number[]): number[] {
    const seen = new Set<string>();
    return rows.filter((r) => {
      const k = this.keyString(r);
      if (k === null) return true;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  /** Store rows with a pending edit, an insert or a delete (for "pending change in a hidden row"). */
  pendingRows(): number[] {
    const n = this.base.rowCount;
    return [
      ...this.snap.edits.keys(),
      ...this.snap.deletes,
      ...this.snap.inserts.map((_, i) => n + i),
    ];
  }

  /** The display row a failed statement came from. */
  rowOfTarget(kind: "update" | "insert" | "delete", index: number): number | null {
    if (kind === "insert")
      return index < this.snap.inserts.length ? this.base.rowCount + index : null;
    const rows = this.firstOfKey(kind === "update" ? this.editedRows() : this.deletedRows());
    return rows[index] ?? null;
  }

  /** The edits as a request for the backend. `keyColumns` must be column names of the table. */
  request(path: NodePath, keyColumns: string[]): ChangeRequest {
    const cols = this.base.columns;
    const map = this.mapping;
    // The table column a result column writes to; the table editor writes to its own names.
    const target = (col: number): string | null =>
      map ? (map.columnMap[col] ?? null) : cols[col].name;
    const keyIdx = map
      ? map.keyIndexes
      : keyColumns.map((k) => cols.findIndex((c) => c.name === k));
    const keyOf = (row: number) => keyIdx.map((i) => this.base.get(i, row));
    // One statement per table row: result rows that share a key are one change.
    const firstOfKey = (rows: number[]) => this.firstOfKey(rows);
    const seenCols = new Set<string>();
    const columns: { name: string; type_name: string }[] = [];
    cols.forEach((c, i) => {
      const t = target(i);
      if (t !== null && !seenCols.has(t)) {
        seenCols.add(t);
        columns.push({ name: t, type_name: c.type_name });
      }
    });
    return {
      path,
      columns,
      keyColumns,
      edits: firstOfKey(this.editedRows()).map((row) => ({
        key: keyOf(row),
        changes: [...this.snap.edits.get(row)!].flatMap(([col, nv]) => {
          const t = target(col);
          return t === null ? [] : [{ column: t, old: this.base.get(col, row), new: nv }];
        }),
      })),
      inserts: this.snap.inserts.map((ins) => ({
        values: [...ins].flatMap(([col, nv]) => {
          const t = target(col);
          return t === null ? [] : [{ column: t, value: nv }];
        }),
      })),
      deletes: firstOfKey(this.deletedRows()).map((row) => ({ key: keyOf(row) })),
    };
  }
}

function shown(nv: NewValue): Value {
  return nv.kind === "value" ? nv.value : DEFAULT_SHOWN;
}
