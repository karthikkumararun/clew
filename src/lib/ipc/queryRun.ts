import type { AppError } from "./index";
import type { ColumnMeta, DriverError, ExecSummary, ResultEvent, Value } from "./drivers";

export type RunStatus = "idle" | "running" | "done" | "failed" | "cancelled";

/** One result set (or one failed / command statement) of a run. */
export interface ResultView {
  /** Stable key: `r<resultId>`, or `s<statement>` for a statement that failed before a result. */
  key: string;
  /** Server-side id used to fetch more rows. `null` for a statement that never produced a result. */
  resultId: number | null;
  /** 0-based index of the statement in a script. */
  statement: number;
  columns: ColumnMeta[];
  /** Grows in place as batches arrive; use `rowCount` to detect changes. */
  rows: Value[][];
  rowCount: number;
  /**
   * The documents of a document-database result (MongoDB), as Extended JSON, for the tree and
   * JSON views. The same result also arrives as `columns` / `rows`, which the grid uses.
   */
  docs?: unknown[];
  /** The current page finished arriving. */
  done: boolean;
  /** The server has more rows to fetch. */
  hasMore: boolean;
  summary?: ExecSummary;
  error?: DriverError;
  cancelled: boolean;
}

export interface QueryRunSnapshot {
  status: RunStatus;
  results: ResultView[];
  /** Session messages, e.g. "The connection was lost and has been re-established." */
  notices: string[];
  /** Set when the run failed without a result-level error event (unknown session, IPC failure). */
  error?: AppError | DriverError;
  /** Rows are being fetched into an existing result. */
  fetching: boolean;
}

const IDLE: QueryRunSnapshot = {
  status: "idle",
  results: [],
  notices: [],
  fetching: false,
};

type Listener = () => void;

/**
 * Accumulates `ResultEvent`s into result sets. A plain class (not a reducer) so that appending a
 * batch of rows is O(batch) and safe under React StrictMode; React reads it through
 * `useSyncExternalStore` and re-renders at most once per microtask, however many events arrive.
 */
export class QueryRunStore {
  private order: string[] = [];
  private byKey = new Map<string, ResultView>();
  private notices: string[] = [];
  private status: RunStatus = "idle";
  private error: AppError | DriverError | undefined;
  private fetching = false;
  private snapshot: QueryRunSnapshot = IDLE;
  private listeners = new Set<Listener>();
  private scheduled = false;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): QueryRunSnapshot => this.snapshot;

  /** Forget the previous run and start a new one. */
  begin(): void {
    this.order = [];
    this.byKey = new Map();
    this.notices = [];
    this.error = undefined;
    this.fetching = false;
    this.status = "running";
    this.changed();
  }

  setFetching(fetching: boolean): void {
    this.fetching = fetching;
    this.changed();
  }

  private ensure(key: string, resultId: number | null, statement: number): ResultView {
    let r = this.byKey.get(key);
    if (!r) {
      r = {
        key,
        resultId,
        statement,
        columns: [],
        rows: [],
        rowCount: 0,
        done: false,
        hasMore: false,
        cancelled: false,
      };
      this.byKey.set(key, r);
      this.order.push(key);
    }
    return r;
  }

  private byResultId(resultId: number | null): ResultView | undefined {
    if (resultId === null) return undefined;
    return this.byKey.get(`r${resultId}`);
  }

  apply(event: ResultEvent): void {
    switch (event.event) {
      case "columns": {
        const r = this.ensure(`r${event.result_id}`, event.result_id, event.statement);
        r.columns = event.columns;
        break;
      }
      case "rows": {
        // a result id we have not seen yet means a statement without columns event; keep going
        const r =
          this.byResultId(event.result_id) ??
          this.ensure(`r${event.result_id}`, event.result_id, 0);
        for (const row of event.rows) r.rows.push(row);
        r.rowCount = r.rows.length;
        break;
      }
      case "done": {
        const r =
          this.byResultId(event.result_id) ??
          this.ensure(`r${event.result_id}`, event.result_id, 0);
        r.summary = event.summary;
        r.done = true;
        r.hasMore = event.summary.has_more;
        break;
      }
      case "error": {
        const r =
          this.byResultId(event.result_id) ??
          this.ensure(`s${event.statement}`, event.result_id, event.statement);
        r.error = event.error;
        r.done = true;
        r.hasMore = false;
        break;
      }
      case "cancelled": {
        const r =
          this.byResultId(event.result_id) ??
          // no id: the statement that was running is the last one still open
          [...this.order]
            .reverse()
            .map((k) => this.byKey.get(k))
            .find((x) => x && !x.done) ??
          this.ensure(`s${this.order.length}`, null, this.order.length);
        r.cancelled = true;
        r.done = true;
        r.hasMore = false;
        break;
      }
      case "documents": {
        const r =
          this.byResultId(event.result_id) ??
          this.ensure(`r${event.result_id}`, event.result_id, 0);
        const docs = (r.docs ??= []);
        for (const d of event.docs) docs.push(d);
        break;
      }
      case "notice":
        this.notices.push(event.message);
        break;
    }
    this.changed();
  }

  /** The run's promise settled. `failure` is the rejection, if any. */
  finish(failure?: AppError | DriverError): void {
    const results = this.order.map((k) => this.byKey.get(k)!);
    const cancelled = results.some((r) => r.cancelled);
    const errored = results.some((r) => r.error);
    if (failure && !errored && !cancelled) this.error = failure;
    this.status = cancelled ? "cancelled" : errored || this.error ? "failed" : "done";
    this.fetching = false;
    this.changed();
  }

  reset(): void {
    this.order = [];
    this.byKey = new Map();
    this.notices = [];
    this.error = undefined;
    this.fetching = false;
    this.status = "idle";
    this.changed();
  }

  /** The last result that still has rows on the server. */
  openResult(): ResultView | undefined {
    return [...this.order]
      .reverse()
      .map((k) => this.byKey.get(k))
      .find((r) => r?.hasMore);
  }

  private changed(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.snapshot = {
        status: this.status,
        results: this.order.map((k) => {
          // new objects so memoised consumers notice; the row arrays themselves are shared
          const r = this.byKey.get(k)!;
          return { ...r };
        }),
        notices: [...this.notices],
        error: this.error,
        fetching: this.fetching,
      };
      this.listeners.forEach((l) => l());
    });
  }
}
