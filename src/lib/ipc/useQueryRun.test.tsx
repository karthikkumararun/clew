import { act, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import type { ReactNode } from "react";
import type { ColumnMeta, ExecSummary, ResultEvent, Value } from "./drivers";

interface Pending {
  sessionId: string;
  request: Record<string, unknown>;
  onEvent: (e: ResultEvent) => void;
  resolve: (s: ExecSummary | null) => void;
  reject: (e: unknown) => void;
}

const calls = vi.hoisted(() => ({
  executes: [] as Pending[],
  fetches: [] as {
    sessionId: string;
    resultId: number;
    count: number;
    onEvent: (e: ResultEvent) => void;
    resolve: (more: boolean) => void;
    reject: (e: unknown) => void;
  }[],
  cancel: vi.fn(async (_id: string) => {}),
}));

vi.mock("./drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "code" in e && "message" in e,
  queryExecute: (
    sessionId: string,
    request: Record<string, unknown>,
    onEvent: (e: ResultEvent) => void,
  ) =>
    new Promise<ExecSummary | null>((resolve, reject) => {
      calls.executes.push({ sessionId, request, onEvent, resolve, reject });
    }),
  queryFetchMore: (
    sessionId: string,
    resultId: number,
    count: number,
    onEvent: (e: ResultEvent) => void,
  ) =>
    new Promise<boolean>((resolve, reject) => {
      calls.fetches.push({ sessionId, resultId, count, onEvent, resolve, reject });
    }),
  queryCancel: calls.cancel,
}));

import { useQueryRun } from "./useQueryRun";
import { QueryRunStore } from "./queryRun";

const col = (name: string): ColumnMeta => ({
  name,
  type_name: "int8",
  kind: "bigint",
  nullable: null,
});
const int = (n: number): Value => ({ kind: "int", value: n });
const summary = (over: Partial<ExecSummary> = {}): ExecSummary => ({
  rows_affected: null,
  elapsed_ms: 3,
  has_more: false,
  ...over,
});

const columns = (id: number, statement = 0, names = ["n"]): ResultEvent => ({
  event: "columns",
  result_id: id,
  statement,
  columns: names.map(col),
});
const rows = (id: number, from: number, count: number): ResultEvent => ({
  event: "rows",
  result_id: id,
  rows: Array.from({ length: count }, (_, i) => [int(from + i)]),
});
const done = (id: number, over: Partial<ExecSummary> = {}): ResultEvent => ({
  event: "done",
  result_id: id,
  summary: summary(over),
});

beforeEach(() => {
  calls.executes.length = 0;
  calls.fetches.length = 0;
  calls.cancel.mockClear();
});

const last = () => calls.executes[calls.executes.length - 1];
const emit = async (...events: ResultEvent[]) => {
  await act(async () => events.forEach((e) => last().onEvent(e)));
};

function setup(sessionId: string | null = "session-1", pageSize?: number) {
  return renderHook(() => useQueryRun(sessionId, { pageSize }));
}

describe("batches", () => {
  it("starts idle, runs, accumulates batches in order and finishes", async () => {
    const { result } = setup();
    expect(result.current.status).toBe("idle");

    let finished!: Promise<void>;
    await act(async () => {
      finished = result.current.run({ sql: "select n from t" });
    });
    expect(result.current.status).toBe("running");
    expect(last().sessionId).toBe("session-1");
    expect(last().request).toMatchObject({ sql: "select n from t", page_size: 500 });

    await emit(columns(1), rows(1, 1, 3));
    expect(result.current.results[0].columns.map((c) => c.name)).toEqual(["n"]);
    expect(result.current.results[0].rowCount).toBe(3);

    await emit(rows(1, 4, 2), done(1));
    const r = result.current.results[0];
    expect(r.rows.map((row) => (row[0] as { value: number }).value)).toEqual([1, 2, 3, 4, 5]);
    expect(r.done).toBe(true);
    expect(r.hasMore).toBe(false);
    expect(r.summary?.elapsed_ms).toBe(3);

    await act(async () => {
      last().resolve(summary());
      await finished;
    });
    expect(result.current.status).toBe("done");
  });

  it("passes the page size and script options through", async () => {
    const { result } = setup("s", 100);
    await act(async () => {
      void result.current.run({ sql: "a; b", script: true, continue_on_error: true });
    });
    expect(last().request).toMatchObject({ page_size: 100, script: true, continue_on_error: true });
  });

  it("handles many batches without losing rows", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "x" });
    });
    await emit(columns(1));
    for (let b = 0; b < 100; b++) await emit(rows(1, b * 500, 500));
    expect(result.current.results[0].rowCount).toBe(50_000);
    expect(result.current.results[0].rows[49_999]).toEqual([int(49_999)]);
  });

  it("coalesces many events into few renders", async () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useQueryRun("s");
    });
    await act(async () => {
      void result.current.run({ sql: "x" });
    });
    const before = renders;
    await emit(columns(1), ...Array.from({ length: 50 }, (_, i) => rows(1, i * 10, 10)), done(1));
    expect(renders - before).toBeLessThanOrEqual(2);
    expect(result.current.results[0].rowCount).toBe(500);
  });
});

describe("paging", () => {
  it("fetchMore pulls the next page of the open result and appends it", async () => {
    const { result } = setup("session-1", 500);
    await act(async () => {
      void result.current.run({ sql: "big" });
    });
    await emit(columns(7), rows(7, 1, 500), done(7, { has_more: true }));
    expect(result.current.results[0].hasMore).toBe(true);

    await act(async () => {
      void result.current.fetchMore();
    });
    expect(calls.fetches).toHaveLength(1);
    expect(calls.fetches[0]).toMatchObject({ sessionId: "session-1", resultId: 7, count: 500 });
    expect(result.current.fetching).toBe(true);

    await act(async () => {
      calls.fetches[0].onEvent(rows(7, 501, 200));
      calls.fetches[0].onEvent(done(7, { has_more: false }));
      calls.fetches[0].resolve(false);
    });
    const r = result.current.results[0];
    expect(r.rowCount).toBe(700);
    expect(r.hasMore).toBe(false);
    expect(result.current.fetching).toBe(false);
  });

  it("fetchMore does nothing when no result has more rows", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "small" });
    });
    await emit(columns(1), rows(1, 1, 3), done(1));
    await act(async () => {
      await result.current.fetchMore();
    });
    expect(calls.fetches).toHaveLength(0);
  });

  it("a failing fetchMore surfaces as an error event on the result", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "big" });
    });
    await emit(columns(1), rows(1, 1, 5), done(1, { has_more: true }));
    await act(async () => {
      void result.current.fetchMore(1);
    });
    await act(async () => {
      calls.fetches[0].onEvent({
        event: "error",
        result_id: 1,
        statement: 0,
        error: { code: "connection_lost", message: "gone" },
      });
      calls.fetches[0].reject({ code: "connection_lost", message: "gone" });
    });
    expect(result.current.results[0].error?.code).toBe("connection_lost");
    expect(result.current.results[0].hasMore).toBe(false);
    expect(result.current.fetching).toBe(false);
  });
});

describe("statements", () => {
  it("a command without a result set reports rows affected", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "update t set a = 1" });
    });
    await emit(done(1, { rows_affected: 12 }));
    expect(result.current.results[0].columns).toEqual([]);
    expect(result.current.results[0].summary?.rows_affected).toBe(12);
    await act(async () => last().resolve(summary({ rows_affected: 12 })));
    expect(result.current.status).toBe("done");
  });

  it("a script yields one result per statement, in order", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "a; b; c", script: true });
    });
    await emit(
      columns(1, 0),
      rows(1, 1, 1),
      done(1),
      done(2, { rows_affected: 4 }),
      columns(3, 2, ["x", "y"]),
      rows(3, 9, 1),
      done(3),
    );
    const results = result.current.results;
    expect(results.map((r) => r.statement)).toEqual([0, 0, 2]);
    expect(results.map((r) => r.resultId)).toEqual([1, 2, 3]);
    expect(results[2].columns).toHaveLength(2);
  });

  it("an error stops the run: failed status, earlier results kept, position preserved", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "a; bad", script: true });
    });
    await emit(columns(1, 0), rows(1, 1, 2), done(1), {
      event: "error",
      result_id: null,
      statement: 1,
      error: { code: "query_failed", message: "syntax error", position: 4, hint: "FROM?" },
    });
    await act(async () => last().reject({ code: "query_failed", message: "syntax error" }));
    expect(result.current.status).toBe("failed");
    expect(result.current.results).toHaveLength(2);
    expect(result.current.results[0].rowCount).toBe(2);
    expect(result.current.results[1].key).toBe("s1");
    expect(result.current.results[1].error).toMatchObject({ position: 4, hint: "FROM?" });
    expect(result.current.error).toBeUndefined(); // the result-level error is the source of truth
  });

  it("a rejection with no error event (e.g. unknown session) lands on the state", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "x" });
    });
    await act(async () => last().reject({ code: "internal", message: 'Unknown session "s"' }));
    expect(result.current.status).toBe("failed");
    expect(result.current.error).toMatchObject({ code: "internal" });
  });

  it("a non-AppError rejection is still reported", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "x" });
    });
    await act(async () => last().reject(new Error("boom")));
    expect(result.current.status).toBe("failed");
    expect(result.current.error?.message).toContain("boom");
  });

  it("collects session notices such as a reconnect", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "select 1" });
    });
    await emit(
      { event: "notice", message: "The connection was lost and has been re-established." },
      columns(1),
      done(1),
    );
    expect(result.current.notices).toEqual([
      "The connection was lost and has been re-established.",
    ]);
  });
});

describe("cancel", () => {
  it("asks the server to cancel and shows the cancelled state", async () => {
    const { result } = setup("session-9");
    await act(async () => {
      void result.current.run({ sql: "select pg_sleep(60)" });
    });
    await act(async () => {
      await result.current.cancel();
    });
    expect(calls.cancel).toHaveBeenCalledWith("session-9");
    // nothing changes until the server confirms
    expect(result.current.status).toBe("running");

    await emit({ event: "cancelled", result_id: null });
    await act(async () =>
      last().reject({ code: "cancelled", message: "The statement was cancelled" }),
    );
    expect(result.current.status).toBe("cancelled");
    expect(result.current.results[0].cancelled).toBe(true);
  });

  it("a cancelled statement marks the open result, not a new one", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "slow" });
    });
    await emit(columns(1), rows(1, 1, 5), { event: "cancelled", result_id: 1 });
    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].cancelled).toBe(true);
    expect(result.current.results[0].rowCount).toBe(5);
  });

  it("cancel never throws when the session is gone", async () => {
    calls.cancel.mockRejectedValueOnce({ code: "internal", message: "Unknown session" });
    const { result } = setup();
    await act(async () => {
      await result.current.cancel();
    });
    expect(calls.cancel).toHaveBeenCalled();
  });
});

describe("lifecycle", () => {
  it("does nothing without a session", async () => {
    const { result } = setup(null);
    await act(async () => {
      await result.current.run({ sql: "x" });
      await result.current.cancel();
      await result.current.fetchMore(1);
    });
    expect(calls.executes).toHaveLength(0);
    expect(calls.cancel).not.toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("a new run clears the previous one and ignores its late events", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "first" });
    });
    const first = calls.executes[0];
    await emit(columns(1), rows(1, 1, 3));

    await act(async () => {
      void result.current.run({ sql: "second" });
    });
    expect(result.current.results).toEqual([]);
    expect(result.current.status).toBe("running");

    // the first run is still streaming: its events must not leak into the second
    await act(async () => {
      first.onEvent(rows(1, 4, 100));
      first.resolve(summary());
    });
    expect(result.current.results).toEqual([]);
    expect(result.current.status).toBe("running");

    await emit(columns(2), rows(2, 1, 1), done(2));
    expect(result.current.results).toHaveLength(1);
    expect(result.current.results[0].resultId).toBe(2);
  });

  it("reset returns to idle and drops in-flight events", async () => {
    const { result } = setup();
    await act(async () => {
      void result.current.run({ sql: "x" });
    });
    const run = calls.executes[0];
    await emit(columns(1), rows(1, 1, 2));
    await act(async () => result.current.reset());
    expect(result.current.status).toBe("idle");
    expect(result.current.results).toEqual([]);
    await act(async () => run.onEvent(rows(1, 3, 2)));
    expect(result.current.results).toEqual([]);
  });

  it("events after unmount are ignored without errors", async () => {
    const { result, unmount } = setup();
    await act(async () => {
      void result.current.run({ sql: "x" });
    });
    const run = calls.executes[0];
    unmount();
    expect(() => {
      run.onEvent(columns(1));
      run.resolve(summary());
    }).not.toThrow();
  });

  it("works under StrictMode (no duplicated rows)", async () => {
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useQueryRun("s"), { wrapper });
    await act(async () => {
      void result.current.run({ sql: "x" });
    });
    await emit(columns(1), rows(1, 1, 10), rows(1, 11, 10), done(1));
    expect(result.current.results[0].rowCount).toBe(20);
    expect(result.current.results[0].rows).toHaveLength(20);
  });
});

describe("QueryRunStore", () => {
  const flush = () => new Promise<void>((r) => queueMicrotask(r));

  it("notifies subscribers once per microtask and returns stable snapshots in between", async () => {
    const store = new QueryRunStore();
    const seen = vi.fn();
    store.subscribe(seen);
    store.begin();
    store.apply(columns(1));
    store.apply(rows(1, 1, 1));
    expect(seen).not.toHaveBeenCalled();
    await flush();
    expect(seen).toHaveBeenCalledTimes(1);
    const a = store.getSnapshot();
    expect(store.getSnapshot()).toBe(a);
  });

  it("a cancel with no id and nothing open still records a cancelled marker", async () => {
    const store = new QueryRunStore();
    store.begin();
    store.apply({ event: "cancelled", result_id: null });
    store.finish({ code: "cancelled", message: "x" });
    await flush();
    expect(store.getSnapshot().status).toBe("cancelled");
    expect(store.getSnapshot().results[0].cancelled).toBe(true);
  });

  it("unsubscribed listeners are not called", async () => {
    const store = new QueryRunStore();
    const seen = vi.fn();
    const off = store.subscribe(seen);
    off();
    store.begin();
    await flush();
    expect(seen).not.toHaveBeenCalled();
  });
});
