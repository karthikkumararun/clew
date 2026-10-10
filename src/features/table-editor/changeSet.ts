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

  constructor(private base: GridSource) {}

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

  isEdited(col: number, row: number): boolean {
    return this.snap.edits.get(row)?.has(col) === true;
  }

  counts(): Counts {
    let edited = 0;
    for (const r of this.snap.edits.keys()) if (!this.snap.deletes.has(r)) edited++;
    const inserted = this.snap.inserts.length;
    const deleted = this.snap.deletes.size;
    return { edited, inserted, deleted, total: edited + inserted + deleted };
  }

  get canUndo() {
    return this.past.length > 0;
  }
  get canRedo() {
    return this.future.length > 0;
  }

  // --- changes -------------------------------------------------------------------------------

  private commit(next: Snap) {
    this.past.push(this.snap);
    this.future = [];
    this.snap = next;
    this.changed();
  }

  /** Set a cell. Writing back the loaded value removes the edit. */
  setCell(row: number, col: number, value: NewValue): void {
    const n = this.base.rowCount;
    const next = copy(this.snap);
    if (row >= n) {
      const ins = next.inserts[row - n];
      if (!ins) return;
      ins.set(col, value);
    } else {
      if (next.deletes.has(row)) return;
      const cells = next.edits.get(row) ?? new Map<number, NewValue>();
      if (value.kind === "value" && same(value.value, this.base.get(col, row))) cells.delete(col);
      else cells.set(col, value);
      if (cells.size === 0) next.edits.delete(row);
      else next.edits.set(row, cells);
    }
    this.commit(next);
  }

  /** Append an empty new row; returns its row index. */
  addRow(): number {
    const next = copy(this.snap);
    next.inserts.push(new Map());
    this.commit(next);
    return this.rowCount - 1;
  }

  /** Mark loaded rows deleted (or restore them when all are already marked); drop new rows. */
  deleteRows(rows: number[]): void {
    const n = this.base.rowCount;
    const next = copy(this.snap);
    const loaded = rows.filter((r) => r < n);
    const fresh = rows.filter((r) => r >= n).sort((a, b) => b - a);
    for (const r of fresh) next.inserts.splice(r - n, 1);
    const restore = loaded.length > 0 && loaded.every((r) => next.deletes.has(r));
    for (const r of loaded) {
      if (restore) next.deletes.delete(r);
      else next.deletes.add(r);
    }
    this.commit(next);
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

  /** The display row a failed statement came from. */
  rowOfTarget(kind: "update" | "insert" | "delete", index: number): number | null {
    if (kind === "insert")
      return index < this.snap.inserts.length ? this.base.rowCount + index : null;
    const rows = kind === "update" ? this.editedRows() : this.deletedRows();
    return rows[index] ?? null;
  }

  /** The edits as a request for the backend. `keyColumns` must be column names of the table. */
  request(path: NodePath, keyColumns: string[]): ChangeRequest {
    const cols = this.base.columns;
    const keyIdx = keyColumns.map((k) => cols.findIndex((c) => c.name === k));
    const keyOf = (row: number) => keyIdx.map((i) => this.base.get(i, row));
    return {
      path,
      columns: cols.map((c) => ({ name: c.name, type_name: c.type_name })),
      keyColumns,
      edits: this.editedRows().map((row) => ({
        key: keyOf(row),
        changes: [...this.snap.edits.get(row)!].map(([col, nv]) => ({
          column: cols[col].name,
          old: this.base.get(col, row),
          new: nv,
        })),
      })),
      inserts: this.snap.inserts.map((ins) => ({
        values: [...ins].map(([col, nv]) => ({ column: cols[col].name, value: nv })),
      })),
      deletes: this.deletedRows().map((row) => ({ key: keyOf(row) })),
    };
  }
}

function shown(nv: NewValue): Value {
  return nv.kind === "value" ? nv.value : DEFAULT_SHOWN;
}
