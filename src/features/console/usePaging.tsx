/**
 * Page-by-page browsing of a console result (spec: sql-console › Result paging). A page is a
 * window over the rows loaded so far; moving forward loads more rows from the open cursor.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { IconButton } from "../../components/Button";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { Menu } from "../../components/Menu";
import { formatShortcut } from "../../lib/platform";
import type { ResultView } from "../../lib/ipc/queryRun";
import { registerShortcut } from "../../shell/registry/shortcuts";
import { useSettings } from "../../stores/settingsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import type { GridSource } from "../grid/source";
import { confirmConsolePending } from "../results/useResultEditing";
import { PAGE_SIZES, PagedSource, lastPlan, nextPage, pageLabel } from "./paging";
import { askChoice } from "./prompts";
import type { ConsoleRuntime } from "./runtime";
import styles from "./Console.module.css";

export interface Paging {
  /** Pages mode is on: the grid shows `source`, a window of the rows. */
  paged: boolean;
  /** The first displayed row of the current page, in the unpaged view's rows. */
  offset: number;
  source: GridSource;
  toolbar: ReactNode;
}

export function usePaging(args: {
  runtime: ConsoleRuntime;
  active: ResultView | undefined;
  /** The rows of the result as shown (after sort and filters). */
  view: GridSource;
  resetKey: string;
}): Paging {
  const { runtime, active, view, resetKey } = args;
  const mode = useSettings((s) => s.settings.resultBrowse);
  const size = useSettings((s) => s.settings.resultPageSize);
  const setSettings = useSettings((s) => s.set);
  const [page, setPage] = useState(0);
  const [sizeMenu, setSizeMenu] = useState(false);
  const sizeButton = useRef<HTMLButtonElement>(null);
  const paged = mode === "pages";

  useEffect(() => setPage(0), [resetKey, size, mode]);

  const loaded = view.rowCount;
  const hasMore = active?.hasMore ?? false;

  /** Pull rows from the open cursor until `end` rows are loaded or the result is complete. */
  const loadUntil = useCallback(
    async (end: number) => {
      for (let guard = 0; guard < 10_000; guard++) {
        const r = runtime.results.getSnapshot().results.find((x) => x.key === active?.key);
        if (!r || r.rowCount >= end || !r.hasMore) return;
        const before = r.rowCount;
        await runtime.fetchMore(active?.key);
        const after = runtime.results.getSnapshot().results.find((x) => x.key === active?.key);
        if (!after || after.rowCount === before) return; // nothing arrived: stop
      }
    },
    [runtime, active?.key],
  );

  const go = useCallback(
    async (target: number | "first" | "last" | "next" | "previous") => {
      if (!(await confirmConsolePending(runtime))) return;
      if (target === "first") return setPage(0);
      if (target === "previous") return setPage((p) => Math.max(0, p - 1));
      if (target === "next") {
        const n = nextPage(page, size, loaded, hasMore);
        if (!n) return;
        if (n.need > 0) await loadUntil(n.page * size + size);
        return setPage(n.page);
      }
      if (target === "last") {
        const plan = lastPlan(size, loaded, hasMore, undefined);
        if (plan.confirm) {
          const answer = await askChoice({
            title: "Go to the last page",
            body: (
              <p>
                The result has more rows on the server. Going to the last page loads all of them
                first, which can take a while and use a lot of memory.
              </p>
            ),
            choices: [
              { id: "cancel", label: "Cancel" },
              { id: "load", label: "Load all rows", variant: "primary" },
            ],
          });
          if (answer !== "load") return;
        }
        if (hasMore) await loadUntil(Number.POSITIVE_INFINITY);
        const total =
          runtime.results.getSnapshot().results.find((x) => x.key === active?.key)?.rowCount ??
          loaded;
        return setPage(Math.max(0, Math.ceil(total / size) - 1));
      }
      setPage(target);
    },
    [runtime, page, size, loaded, hasMore, loadUntil, active?.key],
  );

  // Mod+Alt+Up / Mod+Alt+Down while this console is on screen in pages mode.
  useEffect(() => {
    if (!paged) return;
    const on = () => useWorkspace.getState().activeTabId === runtime.tabId;
    const offs = [
      registerShortcut({
        id: "results.previousPage",
        keys: "Mod+Alt+ArrowUp",
        scope: "grid",
        when: on,
        run: () => void go("previous"),
      }),
      registerShortcut({
        id: "results.nextPage",
        keys: "Mod+Alt+ArrowDown",
        scope: "grid",
        when: on,
        run: () => void go("next"),
      }),
    ];
    return () => offs.forEach((o) => o());
  }, [paged, runtime, go]);

  const offset = paged ? page * size : 0;
  const source = useMemo(
    () => (paged ? new PagedSource(view, page * size, size) : view),
    // `loaded`: the window shows more rows as they arrive
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [paged, view, page, size, loaded],
  );

  const toolbar = paged ? (
    <span className={styles.pager} role="group" aria-label="Pages">
      <IconButton aria-label="First page" disabled={page === 0} onClick={() => void go("first")}>
        <span aria-hidden="true">⇤</span>
      </IconButton>
      <IconButton
        aria-label="Previous page"
        title={`Previous page (${formatShortcut("Mod+Alt+ArrowUp")})`}
        disabled={page === 0}
        onClick={() => void go("previous")}
      >
        <span aria-hidden="true">←</span>
      </IconButton>
      <span className={styles.pageLabel} role="status">
        {pageLabel(page, size, loaded)}
        {hasMore ? "+" : ""}
      </span>
      <IconButton
        aria-label="Next page"
        title={`Next page (${formatShortcut("Mod+Alt+ArrowDown")})`}
        disabled={!nextPage(page, size, loaded, hasMore)}
        onClick={() => void go("next")}
      >
        <span aria-hidden="true">→</span>
      </IconButton>
      <IconButton
        aria-label="Last page"
        disabled={!hasMore && page >= Math.max(0, Math.ceil(loaded / size) - 1)}
        onClick={() => void go("last")}
      >
        <span aria-hidden="true">⇥</span>
      </IconButton>
      <span className={styles.pageSize}>
        <button
          ref={sizeButton}
          type="button"
          className={styles.exportButton}
          aria-haspopup="menu"
          aria-expanded={sizeMenu}
          aria-label={`Page size ${size}`}
          onClick={() => setSizeMenu((o) => !o)}
        >
          {size.toLocaleString()} rows
        </button>
        {sizeMenu ? (
          <>
            <div
              className={styles.menuScrim}
              onMouseDown={() => setSizeMenu(false)}
              aria-hidden="true"
            />
            <AnchoredMenu anchor={sizeButton} align="right">
              <Menu
                aria-label="Page size"
                items={PAGE_SIZES.map((n) => ({
                  id: String(n),
                  label: `${n.toLocaleString()} rows`,
                }))}
                onClose={() => setSizeMenu(false)}
                onSelect={(id) => {
                  setSizeMenu(false);
                  setSettings({ resultPageSize: Number(id) });
                }}
              />
            </AnchoredMenu>
          </>
        ) : null}
      </span>
    </span>
  ) : null;

  return { paged, offset, source, toolbar };
}
