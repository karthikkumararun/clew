/**
 * What a console tab holds while the app runs but does not persist: its database session and
 * whatever is running on it. It lives outside React because only the active tab is mounted, and
 * a query must keep running (and its results keep arriving) while the user looks at another tab.
 */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { sessionSwitchNamespace } from "../../connections/api";
import { useConnections } from "../../connections/connectionsStore";
import {
  DEFAULT_PAGE_SIZE,
  queryCancel,
  queryExecute,
  queryFetchMore,
  sessionClose,
  sessionOpen,
} from "../../lib/ipc/drivers";
import type { DriverError, OpenedSession } from "../../lib/ipc/drivers";
import { QueryRunStore } from "../../lib/ipc/queryRun";
import { useSettings } from "../../stores/settingsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { changesSchema, invalidateSnapshots, loadSnapshot } from "./completion/snapshots";
import { splitDialect } from "./editor/dialects";
import { splitStatements } from "./editor/statements";
import type { ConsoleState } from "./state";

/** One line of the Output tab. */
export interface OutputEntry {
  id: number;
  /** When it finished (ms since the epoch). */
  at: number;
  kind: "ok" | "error" | "cancelled" | "info";
  /** The statement's text, flattened and shortened. */
  statement: string;
  /** `50 rows · 38 ms`, `3 rows affected · 4 ms`, the error message, `Cancelled after 2.1 s`. */
  message: string;
  hint?: string;
  detail?: string;
}

export type ResultTab = "result" | "output" | "explain" | "history";

export interface RunRequest {
  sql: string;
  /** Split into statements and run each in order. */
  script: boolean;
}

export interface RuntimeState {
  sessionId: string | null;
  /** Opening the session (connecting first when needed). */
  opening: boolean;
  /** `via SSH <host>` etc., from the opened session. */
  transport: string | null;
  server: OpenedSession["server"] | null;
  /** A statement or script is running on the session. */
  busy: boolean;
  /** When the running statement started (ms since the epoch). */
  startedAt: number | null;
  output: OutputEntry[];
  tab: ResultTab;
  /** Key of the result sub-tab that is showing. */
  activeResult: string | null;
  /** What was run last, for Re-run. */
  lastRun: RunRequest | null;
}

const INITIAL: RuntimeState = {
  sessionId: null,
  opening: false,
  transport: null,
  server: null,
  busy: false,
  startedAt: null,
  output: [],
  tab: "result",
  activeResult: null,
  lastRun: null,
};

/** Keep the Output log from growing without bound. */
const MAX_OUTPUT = 500;

const preview = (sql: string) => {
  const flat = sql.replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 157)}…` : flat;
};

export const formatSeconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
export const formatRows = (n: number, more: boolean) => `${n.toLocaleString()}${more ? "+" : ""}`;

export class ConsoleRuntime {
  readonly store: StoreApi<RuntimeState> = createStore<RuntimeState>(() => ({ ...INITIAL }));
  /** Results of the last run, accumulated from the streamed events. */
  readonly results = new QueryRunStore();
  private opening: Promise<string> | null = null;
  private closed = false;
  private runId = 0;
  private fetchingNow = false;
  private nextOutputId = 1;

  constructor(
    readonly tabId: string,
    readonly connectionId: string,
  ) {}

  get sessionId(): string | null {
    return this.store.getState().sessionId;
  }

  get busy(): boolean {
    return this.store.getState().busy;
  }

  /** The tab's own session, opened on first use. Connects the connection when it isn't. */
  ensureSession(): Promise<string> {
    const existing = this.sessionId;
    if (existing) return Promise.resolve(existing);
    if (this.opening) return this.opening;
    this.store.setState({ opening: true });
    const attempt = (async () => {
      const ok = await useConnections.getState().connect(this.connectionId);
      if (!ok) throw new Error("The connection isn't available");
      const opened = await sessionOpen(this.connectionId);
      if (this.closed) {
        void sessionClose(opened.sessionId).catch(() => {});
        throw new Error("The console was closed");
      }
      this.store.setState({
        sessionId: opened.sessionId,
        transport: opened.transport,
        server: opened.server,
      });
      this.mirror(opened.sessionId);
      // A database / schema picked on the connection chip before the first run.
      const { database, schema } = this.tabState() ?? {};
      if (database || schema) {
        try {
          await sessionSwitchNamespace(opened.sessionId, { database, schema });
        } catch {
          /* the console still works in the default namespace */
        }
      }
      return opened.sessionId;
    })();
    this.opening = attempt;
    const clear = () => {
      this.opening = null;
      this.store.setState({ opening: false });
    };
    attempt.then(clear, clear);
    return attempt;
  }

  /** Driver id of the console's connection. */
  private driver(): string {
    return (
      useConnections.getState().file.connections.find((c) => c.id === this.connectionId)?.driver ??
      ""
    );
  }

  private pageSize(): number {
    return useSettings.getState().settings.gridPageSize ?? DEFAULT_PAGE_SIZE;
  }

  private log(entry: Omit<OutputEntry, "id" | "at">): void {
    const full: OutputEntry = { ...entry, id: this.nextOutputId++, at: Date.now() };
    this.store.setState((s) => ({ output: [...s.output, full].slice(-MAX_OUTPUT) }));
  }

  setTab(tab: ResultTab): void {
    this.store.setState({ tab });
  }

  setActiveResult(key: string | null): void {
    this.store.setState({ activeResult: key });
  }

  clearOutput(): void {
    this.store.setState({ output: [] });
  }

  /**
   * Run a statement or script. Resolves when the run has ended and been logged. Callers check
   * `busy` first and ask the user to cancel; a second run while busy is refused.
   */
  async run(req: RunRequest): Promise<void> {
    if (this.busy) return;
    const runId = ++this.runId;
    this.store.setState({ busy: true, startedAt: Date.now(), lastRun: req, tab: "result" });
    this.results.begin();
    const started = Date.now();
    try {
      let sessionId: string;
      try {
        sessionId = await this.ensureSession();
      } catch (e) {
        const message = (e as { message?: string }).message ?? "Couldn't open a session";
        this.results.finish({ code: "connection_lost", message } as DriverError);
        this.log({ kind: "error", statement: preview(req.sql), message });
        this.store.setState({ tab: "output" });
        return;
      }
      try {
        await queryExecute(
          sessionId,
          {
            sql: req.sql,
            page_size: this.pageSize(),
            script: req.script,
            continue_on_error: false,
          },
          (event) => {
            if (this.runId === runId) this.results.apply(event);
          },
        );
        this.results.finish();
      } catch (e) {
        const err = e as DriverError;
        this.results.finish(
          typeof err === "object" && err && "message" in err
            ? err
            : ({ code: "internal", message: String(e) } as DriverError),
        );
      }
      await Promise.resolve(); // let the store publish its final snapshot
      if (this.runId === runId) this.afterRun(req, Date.now() - started);
    } finally {
      if (this.runId === runId) this.store.setState({ busy: false, startedAt: null });
    }
  }

  /** Log each statement's outcome, pick the tab to show, and refresh the schema after DDL. */
  private afterRun(req: RunRequest, elapsedMs: number): void {
    const snap = this.results.getSnapshot();
    const statements = req.script
      ? splitStatements(req.sql, splitDialect(this.driver())).map((s) => s.text)
      : [req.sql];
    let sawRows = false;
    let sawProblem = false;
    let schemaChanged = false;
    for (const r of snap.results) {
      const full = statements[r.statement] ?? req.sql;
      const text = preview(full);
      const ms = r.summary?.elapsed_ms;
      if (r.error) {
        sawProblem = true;
        this.log({
          kind: "error",
          statement: text,
          message: r.error.message,
          hint: r.error.hint,
          detail: r.error.detail,
        });
      } else if (r.cancelled) {
        sawProblem = true;
        this.log({
          kind: "cancelled",
          statement: text,
          message: `Cancelled after ${formatSeconds(elapsedMs)}`,
        });
      } else if (r.columns.length > 0) {
        sawRows = true;
        this.log({
          kind: "ok",
          statement: text,
          message: `${formatRows(r.rowCount, r.hasMore)} ${r.rowCount === 1 && !r.hasMore ? "row" : "rows"} · ${ms ?? elapsedMs} ms`,
        });
      } else {
        const n = r.summary?.rows_affected;
        const what =
          n === null || n === undefined
            ? "Done"
            : `${n.toLocaleString()} ${n === 1 ? "row" : "rows"} affected`;
        this.log({ kind: "ok", statement: text, message: `${what} · ${ms ?? elapsedMs} ms` });
        if (changesSchema(full)) schemaChanged = true;
      }
    }
    if (snap.error && snap.results.length === 0) {
      sawProblem = true;
      this.log({ kind: "error", statement: preview(req.sql), message: snap.error.message });
    }
    for (const notice of snap.notices) this.log({ kind: "info", statement: "", message: notice });
    this.store.setState({
      tab: sawRows && !sawProblem ? "result" : "output",
      activeResult: snap.results.find((r) => r.columns.length > 0)?.key ?? null,
    });
    if (schemaChanged) this.refreshSchema();
  }

  /** A DDL statement succeeded: drop the completion snapshot and load a fresh one. */
  private refreshSchema(): void {
    invalidateSnapshots(this.connectionId);
    const connection = useConnections
      .getState()
      .file.connections.find((c) => c.id === this.connectionId);
    const settings = connection?.settings;
    const configured =
      settings && "database" in settings && settings.database ? settings.database : "";
    void loadSnapshot(this.connectionId, this.tabState()?.database ?? configured).catch(() => {});
  }

  /** Ask the server to cancel the running statement. */
  async cancel(): Promise<void> {
    const id = this.sessionId;
    if (!id || !this.busy) return;
    try {
      await queryCancel(id);
    } catch {
      /* nothing to cancel any more */
    }
  }

  /** Resolves once nothing is running (used after asking a busy console to cancel). */
  async whenIdle(timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (this.busy) {
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 20));
    }
    return true;
  }

  /** Pull the next page of a result that has more rows. */
  async fetchMore(resultKey?: string): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    const snap = this.results.getSnapshot();
    const key = resultKey ?? this.store.getState().activeResult;
    const target = snap.results.find((r) => r.key === key) ?? this.results.openResult();
    // `fetchingNow` closes the gap before the store publishes `fetching` to React.
    if (!target || target.resultId === null || !target.hasMore || this.fetchingNow) return;
    this.fetchingNow = true;
    this.results.setFetching(true);
    try {
      await queryFetchMore(id, target.resultId, this.pageSize(), (e) => this.results.apply(e));
    } catch {
      /* a failure arrives as an error event on the result */
    } finally {
      this.fetchingNow = false;
      this.results.setFetching(false);
    }
  }

  private tabState(): ConsoleState | undefined {
    return useWorkspace.getState().tabs.find((t) => t.id === this.tabId)?.state as
      ConsoleState | undefined;
  }

  /** Publish the session id on the tab, where the connection chip looks for it. */
  private mirror(sessionId: string | undefined): void {
    if (this.tabState()) {
      useWorkspace.getState().updateTabState<Partial<ConsoleState>>(this.tabId, { sessionId });
    }
  }

  /** The connection dropped: the session is gone, a new one opens on the next run. */
  sessionLost(): void {
    this.runId += 1; // anything still arriving belongs to a session that no longer exists
    this.store.setState({
      sessionId: null,
      opening: false,
      transport: null,
      server: null,
      busy: false,
      startedAt: null,
    });
    this.mirror(undefined);
  }

  /** Close the tab's session (the tab was closed). */
  close(): void {
    this.closed = true;
    this.runId += 1;
    const id = this.sessionId;
    this.store.setState({ ...INITIAL });
    if (id) void sessionClose(id).catch(() => {});
  }
}

const runtimes = new Map<string, ConsoleRuntime>();

/** The runtime of a console tab, created on first use. */
export function getRuntime(tabId: string, connectionId: string): ConsoleRuntime {
  let r = runtimes.get(tabId);
  if (!r) {
    r = new ConsoleRuntime(tabId, connectionId);
    runtimes.set(tabId, r);
  }
  return r;
}

export function peekRuntime(tabId: string): ConsoleRuntime | undefined {
  return runtimes.get(tabId);
}

export function allRuntimes(): ConsoleRuntime[] {
  return [...runtimes.values()];
}

export function disposeRuntime(tabId: string): void {
  runtimes.get(tabId)?.close();
  runtimes.delete(tabId);
}

/** Test helper. */
export function clearRuntimes(): void {
  for (const r of runtimes.values()) r.close();
  runtimes.clear();
}
