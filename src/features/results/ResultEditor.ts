/**
 * Editing one result of a console run (spec: result-editing). It resolves which table the result's
 * columns come from, holds the staged changes (a `ChangeSet` with the column map and key columns),
 * and submits them through the same engine as the table editor, inside the console's transaction
 * when it is in Manual mode. Like the console runtime it lives outside React.
 */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { useConnections } from "../../connections/connectionsStore";
import type { Value } from "../../lib/ipc/drivers";
import type { ColumnMeta } from "../../lib/ipc/drivers";
import { useSettings } from "../../stores/settingsStore";
import { confirmGuarded } from "../safety/confirm";
import { safetyCheckChanges } from "../safety/ipc";
import type { ConsoleRuntime } from "../console/runtime";
import { RowsSource } from "../grid/source";
import { changesApply, changesPreview } from "../table-editor/api";
import type { ChangeRequest, NewValue, PreviewStatement } from "../table-editor/api";
import { ChangeSet } from "../table-editor/changeSet";
import { changesRefetch, resultsResolveEdit, targetPath } from "./api";
import type { EditResolution, TableRef } from "./api";

export interface SubmitError {
  message: string;
  conflict: boolean;
  /** The result row the failing statement came from. */
  row: number | null;
}

export interface EditorState {
  status: "resolving" | "ready" | "failed";
  resolution: EditResolution | null;
  /** The table the user chose in a joined result (null = the default). */
  chosen: TableRef | null;
  submitting: boolean;
  submitError: SubmitError | null;
  /** After a manual-mode submit: what was sent, until the user commits or rolls back. */
  sent: string | null;
  /** Computed columns are out of date after an edit until the statement is re-run. */
  stale: boolean;
  /** A resolve failure that is not a read-only reason (IPC error). */
  error: string | null;
}

/** Results up to this many rows are re-run automatically after a submit when the setting is on. */
const AUTO_RERUN_ROWS = 1_000;

const DEFAULT_NV: NewValue = { kind: "default" };
const NULL_NV: NewValue = { kind: "value", value: { kind: "null" } };
const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);

export const KEY_READONLY_REASON = "Key columns can't be changed";

export class ResultEditor {
  readonly store: StoreApi<EditorState> = createStore<EditorState>(() => ({
    status: "resolving",
    resolution: null,
    chosen: null,
    submitting: false,
    submitError: null,
    sent: null,
    stale: false,
    error: null,
  }));
  /** Staged changes over the result's rows; present while the result is editable. */
  changes: ChangeSet | null = null;
  /** Result rows edited since the last run, for marking computed columns out of date. */
  private editedRowsSeen = new Set<number>();
  private resolveId = 0;

  constructor(
    readonly runtime: ConsoleRuntime,
    readonly resultKey: string,
    readonly base: RowsSource,
    readonly statement: string,
    readonly driver: string,
  ) {}

  get resolution(): EditResolution | null {
    return this.store.getState().resolution;
  }
  get editable(): boolean {
    return this.resolution?.kind === "editable";
  }

  /** Ask the backend which table the result maps to; builds the change set when editable. */
  async resolve(chosen?: TableRef | null): Promise<void> {
    const id = ++this.resolveId;
    const pick = chosen === undefined ? this.store.getState().chosen : chosen;
    this.store.setState({ status: "resolving", error: null });
    try {
      const sessionId = await this.runtime.ensureSession();
      const res = await resultsResolveEdit(
        this.runtime.connectionId,
        sessionId,
        this.statement,
        this.base.columns,
        pick,
      );
      if (id !== this.resolveId) return;
      if (res.kind === "editable") {
        this.changes = new ChangeSet(this.base, {
          columnMap: res.columnMap,
          keyIndexes: res.keyIndexes,
        });
      } else {
        this.changes = null;
      }
      this.store.setState({ status: "ready", resolution: res, chosen: pick });
    } catch (e) {
      if (id !== this.resolveId) return;
      this.changes = null;
      this.store.setState({ status: "failed", resolution: null, error: messageOf(e) });
    }
  }

  /** Switch the edit table of a joined result; refused while changes are pending. */
  async choose(table: TableRef): Promise<boolean> {
    if (this.changes && this.changes.counts().total > 0) return false;
    await this.resolve(table);
    return true;
  }

  // --- what can be edited ----------------------------------------------------------------------

  /** Whether a cell can be edited, and why not (a header tooltip and the cell's own message). */
  cellState(col: number, row: number): { editable: boolean; reason?: string } {
    const res = this.resolution;
    const cs = this.changes;
    if (res?.kind !== "editable" || !cs) return { editable: false };
    if (cs.rowState(row) === "deleted") return { editable: false, reason: "Row is marked deleted" };
    const edit = res.columns[col];
    if (!edit?.editable) return { editable: false, reason: edit?.reason ?? "Read-only column" };
    // Key columns of rows that came from the database are read-only; new rows may set them.
    if (res.keyIndexes.includes(col) && row < cs.loadedRows) {
      return { editable: false, reason: KEY_READONLY_REASON };
    }
    return { editable: true };
  }

  /** Set NULL is hidden for NOT NULL columns (spec: result-editing › Set NULL on a NOT NULL column). */
  canSetNull(col: number): boolean {
    const res = this.resolution;
    return res?.kind === "editable" && res.columns[col]?.nullable !== false;
  }

  /** Rows can be added only to results of a single table. */
  get canAddRows(): { ok: boolean; reason?: string } {
    const res = this.resolution;
    if (res?.kind !== "editable") return { ok: false };
    return res.candidates.length <= 1
      ? { ok: true }
      : { ok: false, reason: "Rows can only be added to single-table results" };
  }

  /** The notice for a key that appears on several result rows. */
  sharedNotice(row: number): string | null {
    const res = this.resolution;
    const cs = this.changes;
    if (res?.kind !== "editable" || !cs) return null;
    const rows = cs.sharedRows(row);
    if (rows.length < 2) return null;
    const key = res.keyIndexes
      .map((i) => this.base.get(i, row))
      .map(valueLabel)
      .join(", ");
    const noun = res.target.table.replace(/s$/, "");
    const name = noun.charAt(0).toUpperCase() + noun.slice(1);
    return `${name} ${key} appears ${rows.length} times in this result. An edit applies to all ${rows.length}.`;
  }

  // --- staging ---------------------------------------------------------------------------------

  stage(col: number, row: number, value: NewValue): void {
    if (!this.cellState(col, row).editable) return;
    this.changes?.setCell(row, col, value);
    this.afterEdit(row);
  }

  setNull(col: number, row: number): void {
    if (this.canSetNull(col)) this.stage(col, row, NULL_NV);
  }
  setDefault(col: number, row: number): void {
    this.stage(col, row, DEFAULT_NV);
  }

  private afterEdit(row: number): void {
    const cs = this.changes;
    if (!cs) return;
    for (const r of cs.sharedRows(row)) this.editedRowsSeen.add(r);
  }

  /** A new row: DEFAULT in key and generated columns, NULL in the others (spec: Adding rows). */
  addRow(): number | null {
    const res = this.resolution;
    const cs = this.changes;
    if (res?.kind !== "editable" || !cs || !this.canAddRows.ok) return null;
    return cs.group(() => {
      const row = cs.addRow();
      res.columns.forEach((c, i) => {
        const mapped = res.columnMap[i] !== null;
        const isKey = res.keyIndexes.includes(i);
        if (!mapped || !c.editable || isKey || c.hasDefault) return;
        cs.setCell(row, i, NULL_NV);
      });
      return row;
    });
  }

  /** Copies of the selected rows; key columns that the database numbers become DEFAULT. */
  cloneRows(rows: number[]): number[] {
    const res = this.resolution;
    const cs = this.changes;
    if (res?.kind !== "editable" || !cs || !this.canAddRows.ok) return [];
    const added: number[] = [];
    cs.group(() => {
      for (const src of rows) {
        const row = cs.addRow();
        added.push(row);
        res.columns.forEach((c, i) => {
          if (res.columnMap[i] === null || !c.editable) return;
          const isKey = res.keyIndexes.includes(i);
          if (isKey && c.hasDefault) return; // auto-numbered key: the database assigns it
          cs.setCell(row, i, { kind: "value", value: cs.get(i, src) });
        });
      }
    });
    return added;
  }

  /** How many result rows show the table rows about to be deleted (for the join confirmation). */
  deleteInfo(rows: number[]): { tableRows: number; resultRows: number } {
    const cs = this.changes;
    if (!cs) return { tableRows: 0, resultRows: 0 };
    const all = new Set(rows.flatMap((r) => cs.sharedRows(r)));
    return { tableRows: rows.length, resultRows: all.size };
  }

  deleteRows(rows: number[]): void {
    this.changes?.deleteRows(rows);
  }

  /** Put selected cells back to their loaded values. */
  revertCells(cells: { col: number; row: number }[]): void {
    const cs = this.changes;
    if (!cs) return;
    cs.group(() => {
      for (const { col, row } of cells) {
        if (row >= cs.loadedRows) continue;
        if (cs.isEdited(col, row))
          cs.setCell(row, col, { kind: "value", value: cs.original(col, row) });
      }
    });
  }

  revertAll(): void {
    this.changes?.clear();
    this.editedRowsSeen.clear();
    this.store.setState({ submitError: null, sent: null });
  }

  get pendingCount(): number {
    return this.changes?.counts().total ?? 0;
  }

  /** Whether a cell of a computed column is out of date after an edit of its row. */
  isStale(col: number, row: number): boolean {
    const res = this.resolution;
    return (
      this.store.getState().stale &&
      res?.kind === "editable" &&
      res.columnMap[col] === null &&
      this.editedRowsSeen.has(row)
    );
  }

  // --- preview and submit ----------------------------------------------------------------------

  private request(opts: { commit?: boolean } = {}): ChangeRequest {
    const res = this.resolution;
    const cs = this.changes;
    if (res?.kind !== "editable" || !cs) throw new Error("This result isn't editable");
    return {
      ...cs.request(targetPath(this.driver, res.target), res.keyColumns),
      manual: this.runtime.txMode === "manual",
      commitAfter: opts.commit === true ? true : undefined,
    };
  }

  async preview(): Promise<PreviewStatement[]> {
    await useConnections.getState().connect(this.runtime.connectionId);
    return changesPreview(this.runtime.connectionId, this.request());
  }

  /**
   * Send the staged changes. Auto-commit consoles commit; manual ones keep them in the open
   * transaction (and `commit: true` commits it). On failure nothing of this submit remains and
   * every change stays staged.
   */
  async submit(opts: { commit?: boolean } = {}): Promise<boolean> {
    const cs = this.changes;
    const res = this.resolution;
    if (!cs || res?.kind !== "editable") return false;
    if (this.store.getState().submitting || cs.counts().total === 0) return true;
    this.store.setState({ submitting: true, submitError: null });
    try {
      const sessionId = await this.runtime.ensureSession();
      const request = this.request(opts);
      const report = await safetyCheckChanges(this.runtime.connectionId, sessionId, request);
      let token: string | undefined;
      if (report.decision === "block") {
        this.store.setState({
          submitting: false,
          submitError: {
            message: "Blocked: this session is read-only",
            conflict: false,
            row: null,
          },
        });
        return false;
      }
      if (report.decision !== "allow") {
        if (!(await confirmGuarded(report))) {
          this.store.setState({ submitting: false });
          return false;
        }
        token = report.token;
      }
      const outcome = await changesApply(this.runtime.connectionId, sessionId, request, token);
      if (outcome.failure) {
        const f = outcome.failure;
        this.store.setState({
          submitting: false,
          submitError: {
            message: f.message,
            conflict: f.conflict,
            row: cs.rowOfTarget(f.target.kind, f.target.index),
          },
        });
        if (this.runtime.txMode === "manual") {
          this.runtime.store.setState({ txOpen: outcome.transactionOpen });
        }
        return false;
      }
      const summary = describeSubmit(request, this.runtime.txMode === "manual" && !opts.commit);
      const statementText = (await changesPreview(this.runtime.connectionId, request))
        .map((s) => s.sql)
        .join("; ");
      this.runtime.recordSubmit({
        applied: outcome.applied,
        transactionOpen: outcome.transactionOpen,
        committed: opts.commit === true,
        summary,
        statement: statementText,
      });
      await this.afterSubmit(sessionId, request, res);
      const manualOpen = this.runtime.txMode === "manual" && !opts.commit;
      this.store.setState({ submitting: false, sent: manualOpen ? summary : null });
      return true;
    } catch (e) {
      this.store.setState({
        submitting: false,
        submitError: { message: messageOf(e), conflict: false, row: null },
      });
      return false;
    }
  }

  /** The row's current values in the database, as table columns (null when it is gone). */
  async currentValues(row: number): Promise<{ columns: string[]; values: Value[] | null } | null> {
    const res = this.resolution;
    const cs = this.changes;
    if (res?.kind !== "editable" || !cs) return null;
    const sessionId = await this.runtime.ensureSession();
    const columns = [...new Set(res.columnMap.filter((c): c is string => c !== null))];
    const key = res.keyIndexes.map((i) => this.base.get(i, row));
    const [values] = await changesRefetch(
      this.runtime.connectionId,
      sessionId,
      res.target,
      columns,
      res.keyColumns,
      [key],
    );
    return { columns, values: values && values.length > 0 ? values : null };
  }

  /** Put database values into every result row that shows this table row. */
  private writeRow(row: number, columns: string[], values: Value[]): void {
    const res = this.resolution;
    const cs = this.changes;
    if (res?.kind !== "editable" || !cs) return;
    const targets = new Set(cs.sharedRows(row));
    this.runtime.results.patchRows(this.resultKey, (rows) => {
      for (const r of targets) {
        res.columnMap.forEach((tc, col) => {
          const at = tc === null ? -1 : columns.indexOf(tc);
          if (at >= 0 && values[at] && rows[r]) rows[r][col] = values[at];
        });
      }
    });
  }

  /** Reload row: drop its staged edits and show what the database holds now. */
  async reloadRow(row: number): Promise<void> {
    const cs = this.changes;
    if (!cs) return;
    const current = await this.currentValues(row);
    cs.revertRow(row);
    if (current?.values) this.writeRow(row, current.columns, current.values);
    this.store.setState({ submitError: null });
  }

  /**
   * Overwrite: take the database's current values as the "old" values and stage the same edits
   * again, so the submit no longer finds the row changed.
   */
  async overwrite(row: number, opts: { commit?: boolean } = {}): Promise<boolean> {
    const cs = this.changes;
    if (!cs) return false;
    const staged = cs.editsOf(row);
    const current = await this.currentValues(row);
    if (!current?.values) return false; // the row is gone: nothing to overwrite
    cs.revertRow(row);
    this.writeRow(row, current.columns, current.values);
    for (const [col, nv] of staged) cs.setCell(row, col, nv);
    return this.submit(opts);
  }

  /** Show the saved values: read edited rows back, drop deleted rows, reload when rows were added. */
  private async afterSubmit(
    sessionId: string,
    request: ChangeRequest,
    res: Extract<EditResolution, { kind: "editable" }>,
  ): Promise<void> {
    const cs = this.changes!;
    const inserted = request.inserts.length > 0;
    const hadEdits = request.edits.length > 0;
    const keyOf = (row: number) => JSON.stringify(res.keyIndexes.map((i) => this.base.get(i, row)));

    // Read back before the change set is cleared (the keys come from the loaded rows).
    let readBack: { key: string; values: Value[] }[] = [];
    const tableCols = [...new Set(res.columnMap.filter((c): c is string => c !== null))];
    if (hadEdits && tableCols.length > 0) {
      const keys = request.edits.map((e) => e.key);
      const rows = await changesRefetch(
        this.runtime.connectionId,
        sessionId,
        res.target,
        tableCols,
        res.keyColumns,
        keys,
      );
      readBack = keys.map((k, i) => ({ key: JSON.stringify(k), values: rows[i] ?? [] }));
    }
    const deletedKeys = new Set(request.deletes.map((d) => JSON.stringify(d.key)));
    const editedRows = new Set<number>();
    for (let r = 0; r < cs.loadedRows; r++) if (cs.isRowEdited(r)) editedRows.add(r);

    this.runtime.results.patchRows(this.resultKey, (rows) => {
      for (const { key, values } of readBack) {
        if (values.length === 0) continue; // the row is gone: nothing to show
        rows.forEach((row, r) => {
          if (keyOf(r) !== key) return;
          res.columnMap.forEach((tc, col) => {
            const at = tc === null ? -1 : tableCols.indexOf(tc);
            if (at >= 0 && values[at]) row[col] = values[at];
          });
        });
      }
      for (let r = rows.length - 1; r >= 0; r--) if (deletedKeys.has(keyOf(r))) rows.splice(r, 1);
    });

    this.editedRowsSeen = new Set([...this.editedRowsSeen, ...editedRows]);
    cs.clear();
    this.store.setState({ stale: hadEdits && res.columnMap.some((c) => c === null) });
    // New rows have keys only the database knows: read the result again to show them. The
    // setting re-runs small results after any submit so computed columns are current too.
    const auto =
      useSettings.getState().settings.resultAutoRerun && this.base.rowCount <= AUTO_RERUN_ROWS;
    if (inserted || (auto && this.store.getState().stale)) await this.runtime.rerun();
  }
}

function valueLabel(v: Value): string {
  if (v.kind === "null") return "NULL";
  const inner = (v as { value?: unknown }).value;
  return inner === undefined ? v.kind : String(inner);
}

/** "3 UPDATE, 1 INSERT, 1 DELETE" for the message after a submit. */
export function describeSubmit(request: ChangeRequest, inTransaction: boolean): string {
  const parts = [
    request.edits.length ? `${request.edits.length} UPDATE` : null,
    request.inserts.length ? `${request.inserts.length} INSERT` : null,
    request.deletes.length ? `${request.deletes.length} DELETE` : null,
  ].filter(Boolean);
  return inTransaction
    ? `Sent to the open transaction: ${parts.join(", ")}. Not saved until you commit.`
    : `Applied: ${parts.join(", ")}.`;
}

export type { ColumnMeta };
