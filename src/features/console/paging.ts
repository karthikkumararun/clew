import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import type { GridSource } from "../grid/source";

/** The page sizes of the toolbar (custom sizes are free text). */
export const PAGE_SIZES = [100, 500, 1_000];

/** Loading this many rows or more to reach the last page asks first. */
export const LAST_PAGE_CONFIRM_ROWS = 100_000;

export type ResultBrowse = "scroll" | "pages";

/** Zero-based page `page` of `size` rows over `loaded` rows: the row range it covers. */
export function pageWindow(
  page: number,
  size: number,
  loaded: number,
): { from: number; to: number } {
  const from = Math.min(page * size, Math.max(0, loaded - 1));
  return { from, to: Math.min(loaded, page * size + size) };
}

/** "501–1,000" for the toolbar (1-based, inclusive), or "0" for an empty result. */
export function pageLabel(page: number, size: number, loaded: number): string {
  if (loaded === 0) return "0";
  const w = pageWindow(page, size, loaded);
  return `${(w.from + 1).toLocaleString()}–${w.to.toLocaleString()}`;
}

/** The last page's index when every row is known; null while more rows may exist. */
export function lastPage(size: number, loaded: number, hasMore: boolean): number | null {
  return hasMore ? null : Math.max(0, Math.ceil(loaded / size) - 1);
}

/**
 * What Next needs: the rows up to the end of the next page must be loaded. `more` says how many
 * rows to ask the open cursor for (0 = already loaded).
 */
export function nextPage(
  page: number,
  size: number,
  loaded: number,
  hasMore: boolean,
): { page: number; need: number } | null {
  const target = page + 1;
  const end = target * size + size;
  if (target * size >= loaded && !hasMore) return null;
  return { page: target, need: hasMore ? Math.max(0, end - loaded) : 0 };
}

/**
 * Last page: whether it must load more rows first and whether to confirm. `total` is the
 * estimated row count when the database gave one.
 */
export function lastPlan(
  size: number,
  loaded: number,
  hasMore: boolean,
  total?: number,
): { confirm: boolean; known: boolean; page: number | null } {
  if (!hasMore) return { confirm: false, known: true, page: lastPage(size, loaded, false) };
  const remaining = total !== undefined ? Math.max(0, total - loaded) : null;
  const big =
    remaining !== null ? remaining >= LAST_PAGE_CONFIRM_ROWS : loaded >= LAST_PAGE_CONFIRM_ROWS;
  return { confirm: big, known: false, page: null };
}

/** A window of `size` rows starting at `from` over another source (the paged result). */
export class PagedSource implements GridSource {
  constructor(
    private inner: GridSource,
    public from: number,
    public size: number,
  ) {}

  get columns(): ColumnMeta[] {
    return this.inner.columns;
  }
  get rowCount(): number {
    return Math.max(0, Math.min(this.size, this.inner.rowCount - this.from));
  }
  get version(): number {
    return this.inner.version * 31 + this.from;
  }
  get(col: number, row: number): Value {
    return this.inner.get(col, this.from + row);
  }
}
