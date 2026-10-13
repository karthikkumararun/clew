/**
 * Contract: Find on page (spec: data-grid › Find on page). Searches the cells of the VISIBLE
 * rows (the `visibleRows` index, see visibleRows.ts) in row-major order over the displayed
 * columns, case-insensitive by default, with optional whole word and regular expression.
 * Matches carry the display row, the store row and the source column. `FindState` is an
 * immutable cursor: `nextMatch` / `prevMatch` wrap around, `findLabel` gives "3 of 8".
 * Pure and framework-free.
 */
import { valueText } from "../../console/valueFormat";
import type { GridSource } from "../source";

export interface FindOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
}

export type FindMatcher =
  { ok: true; test: (text: string) => boolean } | { ok: false; error: string };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const WORD = "[\\p{L}\\p{N}_]";

/** Compile the query; an empty query matches nothing and an invalid regex reports why. */
export function compileFind(query: string, opts: FindOptions = {}): FindMatcher {
  if (query === "") return { ok: true, test: () => false };
  const body = opts.regex ? query : escapeRegex(query);
  const source = opts.wholeWord ? `(?<!${WORD})(?:${body})(?!${WORD})` : body;
  try {
    const re = new RegExp(source, opts.caseSensitive ? "u" : "iu");
    return { ok: true, test: (t) => re.test(t) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Invalid regular expression" };
  }
}

export interface FindMatch {
  /** Row as displayed (index into the visible rows). */
  row: number;
  /** Row of the store, for edits. */
  storeRow: number;
  /** Source column index. */
  col: number;
}

export interface FindResult {
  matches: FindMatch[];
  /** The query was invalid (a bad regular expression). */
  error?: string;
  /** More cells matched than `maxMatches`; the list is cut. */
  truncated: boolean;
  /** Number of source columns, for `matchLookup`. */
  columnCount: number;
}

export interface FindRange {
  /** Source columns to search, in display order (hidden columns left out). Default: all. */
  columns?: readonly number[];
  maxMatches?: number;
}

/** Find the query over the visible rows (`visible` null: every row of the source). */
export function findMatches(
  source: GridSource,
  visible: ArrayLike<number> | null,
  query: string,
  opts: FindOptions = {},
  range: FindRange = {},
): FindResult {
  const columnCount = source.columns.length;
  const m = compileFind(query, opts);
  if (!m.ok) return { matches: [], error: m.error, truncated: false, columnCount };
  const cols = range.columns ?? Array.from({ length: columnCount }, (_, i) => i);
  const max = range.maxMatches ?? 1_000_000;
  const matches: FindMatch[] = [];
  const n = visible ? visible.length : source.rowCount;
  let truncated = false;
  if (query !== "") {
    outer: for (let row = 0; row < n; row++) {
      const storeRow = visible ? visible[row] : row;
      for (const col of cols) {
        const text = valueText(source.get(col, storeRow));
        if (text !== null && m.test(text)) {
          if (matches.length >= max) {
            truncated = true;
            break outer;
          }
          matches.push({ row, storeRow, col });
        }
      }
    }
  }
  return { matches, truncated, columnCount };
}

/** O(1) "is this displayed cell a match", for painting highlights. */
export function matchLookup(result: FindResult): (row: number, col: number) => boolean {
  const keys = new Set<number>();
  for (const m of result.matches) keys.add(m.row * result.columnCount + m.col);
  return (row, col) => keys.has(row * result.columnCount + col);
}

export interface FindState {
  result: FindResult;
  /** Index of the current match, -1 when there is none. */
  index: number;
}

/** Start at the first match at or after the cell `from` (display row, source column). */
export function startFind(result: FindResult, from?: { row: number; col: number }): FindState {
  if (result.matches.length === 0) return { result, index: -1 };
  if (!from) return { result, index: 0 };
  const i = result.matches.findIndex(
    (m) => m.row > from.row || (m.row === from.row && m.col >= from.col),
  );
  return { result, index: i < 0 ? 0 : i };
}

export function nextMatch(state: FindState): FindState {
  const n = state.result.matches.length;
  return n === 0 ? state : { ...state, index: (state.index + 1) % n };
}

export function prevMatch(state: FindState): FindState {
  const n = state.result.matches.length;
  return n === 0 ? state : { ...state, index: (state.index - 1 + n) % n };
}

export function currentMatch(state: FindState): FindMatch | null {
  return state.result.matches[state.index] ?? null;
}

/** "3 of 8"; "No results" when the query matched nothing; "" before anything was typed. */
export function findLabel(state: FindState, query: string): string {
  if (state.result.error) return "Invalid pattern";
  if (query === "") return "";
  const n = state.result.matches.length;
  if (n === 0) return "No results";
  const more = state.result.truncated ? "+" : "";
  return `${state.index + 1} of ${n}${more}`;
}
