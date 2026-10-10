import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { DEFAULT_PAGE_SIZE, queryCancel, queryExecute, queryFetchMore } from "./drivers";
import type { ExecOptions } from "./drivers";
import { isAppError } from "./drivers";
import { QueryRunStore } from "./queryRun";
import type { QueryRunSnapshot } from "./queryRun";

export interface UseQueryRun extends QueryRunSnapshot {
  /** Run a statement or script. Resolves when the run ends; failures show up in the state. */
  run: (options: ExecOptions) => Promise<void>;
  /** Fetch the next page of the open result (or of `resultId`). */
  fetchMore: (resultId?: number) => Promise<void>;
  /** Ask the server to cancel the running statement. */
  cancel: () => Promise<void>;
  /** Back to idle, dropping all results. */
  reset: () => void;
}

/**
 * Runs queries on a session and accumulates the streamed batches.
 *
 * Starting a new run (or unmounting) makes the previous run's late events harmless: each run
 * only feeds the store while it is still the current one.
 */
export function useQueryRun(
  sessionId: string | null,
  { pageSize = DEFAULT_PAGE_SIZE }: { pageSize?: number } = {},
): UseQueryRun {
  const store = useMemo(() => new QueryRunStore(), []);
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const current = useRef(0);

  useEffect(
    () => () => {
      current.current = -1; // unmounted: ignore anything still arriving
    },
    [],
  );

  const run = useCallback(
    async (options: ExecOptions) => {
      if (!sessionId) return;
      const id = ++current.current;
      store.begin();
      try {
        await queryExecute(sessionId, { page_size: pageSize, ...options }, (event) => {
          if (current.current === id) store.apply(event);
        });
        if (current.current === id) store.finish();
      } catch (e) {
        if (current.current === id) {
          store.finish(isAppError(e) ? e : { code: "internal", message: String(e) });
        }
      }
    },
    [sessionId, pageSize, store],
  );

  const fetchMore = useCallback(
    async (resultId?: number) => {
      if (!sessionId) return;
      const target = resultId ?? store.openResult()?.resultId ?? undefined;
      if (target === undefined) return;
      const id = current.current;
      store.setFetching(true);
      try {
        await queryFetchMore(sessionId, target, pageSize, (event) => {
          if (current.current === id) store.apply(event);
        });
      } catch {
        // a failure arrives as an `error` event on the result
      } finally {
        if (current.current === id) store.setFetching(false);
      }
    },
    [sessionId, pageSize, store],
  );

  const cancel = useCallback(async () => {
    if (!sessionId) return;
    try {
      await queryCancel(sessionId);
    } catch {
      // nothing to cancel, or the session is gone
    }
  }, [sessionId]);

  const reset = useCallback(() => {
    current.current += 1;
    store.reset();
  }, [store]);

  return { ...snapshot, run, fetchMore, cancel, reset };
}
