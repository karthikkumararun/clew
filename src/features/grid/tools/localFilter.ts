/**
 * Contract: per-column local filters over the loaded rows (spec: data-grid › Local filter).
 * A filter never changes the statement or the database; `filterRows` returns the matching
 * STORE row indexes (feed them to `buildVisible` in visibleRows.ts). Filters combine with AND.
 * Numeric comparisons are exact (decimal.ts); dates compare as ISO text truncated to the length
 * of the operand, so `= 2024-01-05` matches every time on that day. NULL matches only isNull.
 * Pure and framework-free.
 */
import type { ColumnMeta, Value, ValueKind } from "../../../lib/ipc/drivers";
import { valueText } from "../../console/valueFormat";
import type { GridSource } from "../source";
import { compareNumeric, numericOf, parseDecimal } from "./decimal";

export type FilterOp =
  | "contains"
  | "equals"
  | "startsWith"
  | "endsWith"
  | "isNull"
  | "notNull"
  | "eq"
  | "ne"
  | "lt"
  | "gt"
  | "le"
  | "ge"
  | "between";

export interface ColumnFilter {
  /** Source (store) column index. */
  column: number;
  op: FilterOp;
  value?: string;
  /** Upper bound of `between` (inclusive). */
  value2?: string;
}

const NUMERIC = new Set<ValueKind>(["int", "bigint", "float", "decimal"]);
const DATES = new Set<ValueKind>(["date", "time", "timestamp", "timestamptz"]);

export const isNumericKind = (k: ValueKind) => NUMERIC.has(k);
export const isDateKind = (k: ValueKind) => DATES.has(k);

/** The operators the filter row offers for a column kind. */
export function opsFor(kind: ValueKind): FilterOp[] {
  const base: FilterOp[] = ["contains", "equals", "startsWith", "endsWith", "isNull", "notNull"];
  return NUMERIC.has(kind) || DATES.has(kind)
    ? [...base, "eq", "ne", "lt", "gt", "le", "ge", "between"]
    : base;
}

export type ParsedFilter =
  { ok: true; filter: Omit<ColumnFilter, "column"> | null } | { ok: false; error: string };

const COMPARE: Record<string, FilterOp> = {
  "=": "eq",
  "!=": "ne",
  "<>": "ne",
  "≠": "ne",
  "<": "lt",
  ">": "gt",
  "<=": "le",
  "≤": "le",
  ">=": "ge",
  "≥": "ge",
};

/**
 * Turn what the user typed in a filter cell into a filter: "ship" (contains, or equals on
 * numbers and dates), "contains ship", "starts with a", "null", "not null", "> 200", "<> 3",
 * "100..200" and "between 100 and 200". Empty text means no filter.
 */
export function parseFilterInput(raw: string, kind: ValueKind): ParsedFilter {
  const text = raw.trim();
  if (!text) return { ok: true, filter: null };
  let m: RegExpExecArray | null;
  if (/^(is\s+)?not\s+null$/i.test(text)) return { ok: true, filter: { op: "notNull" } };
  if (/^(is\s+)?null$/i.test(text)) return { ok: true, filter: { op: "isNull" } };
  if ((m = /^contains\s+(.+)$/i.exec(text))) return done({ op: "contains", value: m[1] }, kind);
  if ((m = /^equals\s+(.+)$/i.exec(text))) return done({ op: "equals", value: m[1] }, kind);
  if ((m = /^starts?\s*with\s+(.+)$/i.exec(text))) {
    return done({ op: "startsWith", value: m[1] }, kind);
  }
  if ((m = /^ends?\s*with\s+(.+)$/i.exec(text))) return done({ op: "endsWith", value: m[1] }, kind);
  if ((m = /^(>=|<=|<>|!=|≠|≥|≤|=|>|<)\s*(.+)$/.exec(text))) {
    return done({ op: COMPARE[m[1]], value: m[2].trim() }, kind);
  }
  const ranged = NUMERIC.has(kind) || DATES.has(kind);
  if (ranged) {
    if (
      (m = /^between\s+(.+?)\s+and\s+(.+)$/i.exec(text)) ||
      (m = /^(.+?)\s*\.\.\s*(.+)$/.exec(text))
    ) {
      return done({ op: "between", value: m[1].trim(), value2: m[2].trim() }, kind);
    }
    return done({ op: "eq", value: text }, kind);
  }
  return { ok: true, filter: { op: "contains", value: text } };
}

function done(filter: Omit<ColumnFilter, "column">, kind: ValueKind): ParsedFilter {
  const c = compileFilter({ column: 0, ...filter }, kind);
  return c.ok ? { ok: true, filter } : c;
}

export type Compiled = { ok: true; test: (v: Value) => boolean } | { ok: false; error: string };

const iso = (s: string) => s.trim().replace("T", " ");

/** Build the per-cell predicate of a filter, validating its operands against the column kind. */
export function compileFilter(f: ColumnFilter, kind: ValueKind): Compiled {
  const { op } = f;
  if (op === "isNull") return { ok: true, test: (v) => v.kind === "null" };
  if (op === "notNull") return { ok: true, test: (v) => v.kind !== "null" };
  const operand = f.value ?? "";
  if (op === "contains" || op === "equals" || op === "startsWith" || op === "endsWith") {
    const needle = operand.toLowerCase();
    const test = (s: string) =>
      op === "contains"
        ? s.includes(needle)
        : op === "equals"
          ? s === needle
          : op === "startsWith"
            ? s.startsWith(needle)
            : s.endsWith(needle);
    return {
      ok: true,
      test: (v) => {
        const t = valueText(v);
        return t !== null && test(t.toLowerCase());
      },
    };
  }
  // Comparisons and ranges.
  const ops = op === "between" ? [operand, f.value2 ?? ""] : [operand];
  if (NUMERIC.has(kind)) {
    const parsed = ops.map((o) => parseDecimal(o));
    const bad = ops.findIndex((_, i) => !parsed[i]);
    if (bad >= 0) return { ok: false, error: `'${ops[bad]}' is not a number` };
    const [lo, hi] = parsed as [NonNullable<(typeof parsed)[0]>, (typeof parsed)[0]];
    return {
      ok: true,
      test: (v) => {
        const n = numericOf(v);
        if (!n) return false;
        const c = compareNumeric(n, { exact: lo });
        switch (op) {
          case "eq":
            return c === 0;
          case "ne":
            return c !== 0;
          case "lt":
            return c < 0;
          case "gt":
            return c > 0;
          case "le":
            return c <= 0;
          case "ge":
            return c >= 0;
          default:
            return c >= 0 && hi !== null && compareNumeric(n, { exact: hi }) <= 0;
        }
      },
    };
  }
  const dates = DATES.has(kind);
  const norm = dates ? iso : (s: string) => s.toLowerCase();
  const cmp = (text: string, bound: string): number => {
    const b = norm(bound);
    const t = norm(text);
    const head = dates ? t.slice(0, b.length) : t;
    return head < b ? -1 : head > b ? 1 : 0;
  };
  return {
    ok: true,
    test: (v) => {
      const t = valueText(v);
      if (t === null) return false;
      const c = cmp(t, operand);
      switch (op) {
        case "eq":
          return c === 0;
        case "ne":
          return c !== 0;
        case "lt":
          return c < 0;
        case "gt":
          return c > 0;
        case "le":
          return c <= 0;
        case "ge":
          return c >= 0;
        default:
          return c >= 0 && cmp(t, ops[1]) <= 0;
      }
    },
  };
}

export interface FilterRowsOptions {
  /** Only consider these store rows (default: every loaded row). */
  candidates?: ArrayLike<number>;
}

/** Store rows matching every filter. Filters that fail to compile are ignored (validate earlier). */
export function filterRows(
  source: GridSource,
  filters: readonly ColumnFilter[],
  opts: FilterRowsOptions = {},
): Uint32Array {
  const tests: { col: number; test: (v: Value) => boolean }[] = [];
  for (const f of filters) {
    const meta: ColumnMeta | undefined = source.columns[f.column];
    if (!meta) continue;
    const c = compileFilter(f, meta.kind);
    if (c.ok) tests.push({ col: f.column, test: c.test });
  }
  const n = opts.candidates ? opts.candidates.length : source.rowCount;
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = opts.candidates ? opts.candidates[i] : i;
    let ok = true;
    for (const t of tests) {
      if (!t.test(source.get(t.col, r))) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(r);
  }
  return Uint32Array.from(out);
}

/** "Showing 12 of 340 rows" */
export function filterSummary(shown: number, total: number): string {
  return `Showing ${shown} of ${total} ${total === 1 ? "row" : "rows"}`;
}

/**
 * Pending changes sit on STORE rows, so a filter or find never loses them. This counts the
 * rows with pending changes that the current view hides. `visible` is the `visibleRows` index
 * (null: nothing is hidden); rows at or past `loadedRows` are inserted rows and always show.
 */
export function hiddenPending(
  pendingRows: Iterable<number>,
  visible: ArrayLike<number> | null,
  loadedRows: number,
): number {
  if (!visible) return 0;
  const shown = new Set<number>();
  for (let i = 0; i < visible.length; i++) shown.add(visible[i]);
  let hidden = 0;
  for (const r of new Set(pendingRows)) if (r < loadedRows && !shown.has(r)) hidden++;
  return hidden;
}

/** "1 pending change is in a hidden row" / "3 pending changes are in hidden rows"; "" for none. */
export function hiddenPendingNote(count: number): string {
  if (count <= 0) return "";
  return count === 1
    ? "1 pending change is in a hidden row"
    : `${count} pending changes are in hidden rows`;
}
