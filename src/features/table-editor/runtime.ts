/**
 * What a table-editor tab holds while the app runs: its database session, the loaded page of
 * rows, the table's metadata and the paging / count state. Like the console's runtime it lives
 * outside React, so a load keeps going while another tab is on screen.
 */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { useConnections } from "../../connections/connectionsStore";
import { introspectDdl, queryExecute, sessionClose, sessionOpen } from "../../lib/ipc/drivers";
import type { DriverError, NodePath } from "../../lib/ipc/drivers";
import { QueryRunStore } from "../../lib/ipc/queryRun";
import { useWorkspace } from "../../stores/workspaceStore";
import { ColumnarStore } from "../grid/source";
import { changesApply, changesPreview, tableMeta, tableQuerySql } from "./api";
import type { PreviewStatement } from "./api";
import { ChangeSet } from "./changeSet";
import type { TableMeta } from "./api";
import { rowKeyColumns } from "./state";
import type { PageSize, TableTabState } from "./state";

/** Above this many estimated rows the exact count is offered, not run. */
export const EXACT_COUNT_LIMIT = 1_000_000;

export type Total =
  | { kind: "exact"; rows: number }
  | { kind: "estimate"; rows: number }
  | { kind: "counting" }
  | { kind: "unknown" };

export interface TableRuntimeState {
  sessionId: string | null;
  meta: TableMeta | null;
  metaError: string | null;
  /** Columns that identify a row (primary or unique key), when there are any. */
  keyColumns: string[] | null;
  loading: boolean;
  loaded: boolean;
  elapsedMs: number | null;
  /** A WHERE / ORDER BY the database rejected; the previous rows stay on screen. */
  filterError: string | null;
  /** A load failure that isn't about the filter (connection lost, permissions). */
  loadError: string | null;
  total: Total;
  /** The SELECT behind the rows on screen, for Open in console. */
  sql: string | null;
  ddl: string | null;
  ddlError: string | null;
  /** The last submit failed: why, and which row (display index) it came from. */
  submitError: { message: string; conflict: boolean; row: number | null } | null;
  submitting: boolean;
}

const INITIAL: TableRuntimeState = {
  sessionId: null,
  meta: null,
  metaError: null,
  keyColumns: null,
  loading: false,
  loaded: false,
  elapsedMs: null,
  filterError: null,
  loadError: null,
  total: { kind: "unknown" },
  sql: null,
  ddl: null,
  ddlError: null,
  submitError: null,
  submitting: false,
};

const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);

const queryKey = (q: { where: string; orderBy: string; page: number; pageSize: number }) =>
  JSON.stringify([q.where, q.orderBy, q.page, q.pageSize]);

export class TableRuntime {
  readonly store: StoreApi<TableRuntimeState> = createStore<TableRuntimeState>(() => ({
    ...INITIAL,
  }));
  /** The loaded page. */
  readonly data = new ColumnarStore();
  /** Staged edits over `data`. */
  readonly changes = new ChangeSet(this.data);
  /** Whether cells can be edited (set by the editor from the table's key and the connection). */
  editable = false;
  /** Rows selected in the grid, for Delete row. */
  selectedRows: number[] = [];
  private lastQuery: Pick<TableTabState, "where" | "orderBy" | "page" | "pageSize"> | null = null;
  private opening: Promise<string> | null = null;
  private closed = false;
  private runId = 0;
  private countedFor: string | null = null;
  private loadedKey: string | null = null;

  constructor(
    readonly tabId: string,
    readonly connectionId: string,
    readonly path: NodePath,
  ) {}

  get sessionId(): string | null {
    return this.store.getState().sessionId;
  }

  ensureSession(): Promise<string> {
    const existing = this.sessionId;
    if (existing) return Promise.resolve(existing);
    if (this.opening) return this.opening;
    const attempt = (async () => {
      if (!(await useConnections.getState().connect(this.connectionId))) {
        throw new Error("The connection isn't available");
      }
      const opened = await sessionOpen(this.connectionId);
      if (this.closed) {
        void sessionClose(opened.sessionId).catch(() => {});
        throw new Error("The table was closed");
      }
      this.store.setState({ sessionId: opened.sessionId });
      if (useWorkspace.getState().tabs.some((t) => t.id === this.tabId)) {
        useWorkspace
          .getState()
          .updateTabState<Partial<TableTabState>>(this.tabId, { sessionId: opened.sessionId });
      }
      return opened.sessionId;
    })();
    this.opening = attempt;
    const clear = () => (this.opening = null);
    attempt.then(clear, clear);
    return attempt;
  }

  /** The connection dropped: the session is gone; the next load opens another. */
  sessionLost(): void {
    this.runId += 1;
    this.store.setState({ sessionId: null, loading: false });
  }

  async loadMeta(): Promise<TableMeta | null> {
    const have = this.store.getState().meta;
    if (have) return have;
    try {
      if (!(await useConnections.getState().connect(this.connectionId))) return null;
      const meta = await tableMeta(this.connectionId, this.path);
      this.store.setState({ meta, metaError: null, keyColumns: rowKeyColumns(meta) });
      return meta;
    } catch (e) {
      this.store.setState({ metaError: messageOf(e) });
      return null;
    }
  }

  /** Run a statement on the session and collect its first result. */
  private async run(sessionId: string, sql: string, pageSize: number) {
    const results = new QueryRunStore();
    results.begin();
    try {
      await queryExecute(
        sessionId,
        { sql, page_size: pageSize, script: false, continue_on_error: false },
        (e) => results.apply(e),
      );
      results.finish();
    } catch (e) {
      results.finish(e as DriverError);
    }
    await Promise.resolve(); // let the store publish its final snapshot
    const snap = results.getSnapshot();
    return { result: snap.results[0], error: snap.results[0]?.error ?? snap.error };
  }

  /** Load the page unless it is already what is on screen (switching back to the tab). */
  async loadIfNeeded(
    q: Pick<TableTabState, "where" | "orderBy" | "page" | "pageSize">,
  ): Promise<boolean> {
    if (this.store.getState().loaded && this.loadedKey === queryKey(q)) return true;
    return this.load(q);
  }

  /** Load a page. A filter the database rejects leaves the previous rows in place. */
  async load(q: Pick<TableTabState, "where" | "orderBy" | "page" | "pageSize">): Promise<boolean> {
    const id = ++this.runId;
    this.store.setState({ loading: true, filterError: null, loadError: null });
    try {
      const sessionId = await this.ensureSession();
      const meta = await this.loadMeta();
      const query = await tableQuerySql(this.connectionId, {
        path: this.path,
        whereClause: q.where || null,
        orderBy: q.orderBy || null,
        offset: q.page * q.pageSize,
        limit: q.pageSize,
        defaultOrder: this.store.getState().keyColumns ?? [],
      });
      const { result, error } = await this.run(sessionId, query.select, q.pageSize);
      if (id !== this.runId) return false;
      if (error || !result) {
        const message = error?.message ?? "The table returned no result";
        const filtered = Boolean(q.where.trim() || q.orderBy.trim());
        this.store.setState(
          filtered
            ? { filterError: message, loading: false }
            : { loadError: message, loading: false },
        );
        return false;
      }
      this.changes.clear();
      this.data.reset(result.columns);
      this.data.replace(result.rows);
      this.loadedKey = queryKey(q);
      this.lastQuery = q;
      this.store.setState({
        loaded: true,
        loading: false,
        submitError: null,
        elapsedMs: result.summary?.elapsed_ms ?? null,
        sql: query.select,
      });
      void this.updateTotal(sessionId, query.count, q, meta, id);
      return true;
    } catch (e) {
      if (id === this.runId) this.store.setState({ loading: false, loadError: messageOf(e) });
      return false;
    }
  }

  /** Exact for small tables, "≈estimate" for big unfiltered ones, otherwise on request. */
  private async updateTotal(
    sessionId: string,
    countSql: string,
    q: { where: string },
    meta: TableMeta | null,
    id: number,
  ) {
    const key = q.where.trim();
    if (this.countedFor === key && this.store.getState().total.kind === "exact") return;
    const estimate = meta?.estimatedRows ?? null;
    if (estimate !== null && estimate >= EXACT_COUNT_LIMIT) {
      this.countedFor = null;
      this.store.setState({
        total: key ? { kind: "unknown" } : { kind: "estimate", rows: estimate },
      });
      return;
    }
    await this.count(sessionId, countSql, key, id);
  }

  private async count(sessionId: string, countSql: string, key: string, id: number) {
    this.store.setState({ total: { kind: "counting" } });
    const { result } = await this.run(sessionId, countSql, 1);
    if (id !== this.runId) return;
    const cell = result?.rows[0]?.[0];
    const n =
      cell &&
      (cell.kind === "int"
        ? cell.value
        : cell.kind === "bigint" || cell.kind === "decimal"
          ? Number(cell.value)
          : NaN);
    if (typeof n === "number" && Number.isFinite(n)) {
      this.countedFor = key;
      this.store.setState({ total: { kind: "exact", rows: n } });
    } else {
      this.store.setState({ total: { kind: "unknown" } });
    }
  }

  /** The "Count exactly" action for a big table. */
  async countExactly(
    q: Pick<TableTabState, "where" | "orderBy" | "page" | "pageSize">,
  ): Promise<void> {
    const sessionId = await this.ensureSession();
    const query = await tableQuerySql(this.connectionId, {
      path: this.path,
      whereClause: q.where || null,
      orderBy: null,
      offset: 0,
      limit: 1,
      defaultOrder: [],
    });
    await this.count(sessionId, query.count, q.where.trim(), this.runId);
  }

  async loadDdl(): Promise<void> {
    if (this.store.getState().ddl !== null) return;
    try {
      await useConnections.getState().connect(this.connectionId);
      this.store.setState({
        ddl: await introspectDdl(this.connectionId, this.path),
        ddlError: null,
      });
    } catch (e) {
      this.store.setState({ ddlError: messageOf(e) });
    }
  }

  private changeRequest() {
    const keys = this.store.getState().keyColumns;
    if (!keys) throw new Error("This table has no key to identify rows by");
    return this.changes.request(this.path, keys);
  }

  /** The SQL the staged edits would run. */
  async previewChanges(): Promise<PreviewStatement[]> {
    await useConnections.getState().connect(this.connectionId);
    return changesPreview(this.connectionId, this.changeRequest());
  }

  /**
   * Write the staged edits in one transaction. On success the page reloads and the edits are
   * gone; on failure nothing was written and every edit stays pending.
   */
  async submit(): Promise<boolean> {
    if (this.store.getState().submitting || this.changes.counts().total === 0) return true;
    this.store.setState({ submitting: true, submitError: null });
    try {
      const sessionId = await this.ensureSession();
      const outcome = await changesApply(this.connectionId, sessionId, this.changeRequest());
      if (outcome.failure) {
        const f = outcome.failure;
        this.store.setState({
          submitting: false,
          submitError: {
            message: f.message,
            conflict: f.conflict,
            row: this.changes.rowOfTarget(f.target.kind, f.target.index),
          },
        });
        return false;
      }
    } catch (e) {
      this.store.setState({
        submitting: false,
        submitError: { message: messageOf(e), conflict: false, row: null },
      });
      return false;
    }
    this.changes.clear();
    this.store.setState({ submitting: false });
    this.countedFor = null;
    if (this.lastQuery) await this.load(this.lastQuery);
    return true;
  }

  /** Drop the staged edits and read the page again. */
  async discardAndReload(): Promise<void> {
    this.changes.clear();
    this.store.setState({ submitError: null });
    if (this.lastQuery) await this.load(this.lastQuery);
  }

  /** Forget what was loaded (after a submit, or Refresh), keeping the session. */
  invalidate(): void {
    this.countedFor = null;
    this.store.setState({ meta: null, ddl: null });
  }

  close(): void {
    this.closed = true;
    this.runId += 1;
    const id = this.sessionId;
    this.store.setState({ ...INITIAL });
    if (id) void sessionClose(id).catch(() => {});
  }
}

const runtimes = new Map<string, TableRuntime>();

export function getTableRuntime(tabId: string, connectionId: string, path: NodePath): TableRuntime {
  let r = runtimes.get(tabId);
  if (!r) {
    r = new TableRuntime(tabId, connectionId, path);
    runtimes.set(tabId, r);
  }
  return r;
}

export const peekTableRuntime = (tabId: string) => runtimes.get(tabId);

export function disposeTableRuntime(tabId: string): void {
  runtimes.get(tabId)?.close();
  runtimes.delete(tabId);
}

/** Test helper. */
export function clearTableRuntimes(): void {
  for (const r of runtimes.values()) r.close();
  runtimes.clear();
}

export type { PageSize };
