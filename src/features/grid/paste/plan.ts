/**
 * Paste planner (pure, no React).
 *
 * Contract:
 *  - `plan(table, selection, columns, editable, opts)` turns a parsed table into assignments.
 *    Nothing is staged here; `adapter.stage` applies the result.
 *  - `table` cells are strings (parsed with the cell editors' `parseEdit`, so validation is
 *    identical) or typed `Value`s (from the Clew clipboard payload; same-kind values are used
 *    as-is, so exact decimals and NULL vs '' survive). Rows may be ragged: missing cells are
 *    skipped.
 *  - `selection` is a rectangle in display coordinates (row, col, rows, cols; at least 1x1).
 *    `columns` are in display-column order; `editable=false` skips everything.
 *  - Placement follows the spec: one value over a bigger selection fills it; a block over a
 *    selection that is an exact multiple tiles; otherwise the block fills right and down from the
 *    top-left. With a matching header (`opts.hasHeader`) values map by column name; a header
 *    that matches nothing is dropped and values map by position.
 *  - Empty / `NULL` rules: text-like columns keep '' as an empty string and treat exactly `NULL`
 *    as SQL NULL; every other kind treats '' and `NULL` (any case) as NULL (JSON: only `NULL`).
 *    A NOT NULL column (`nullable === false`) reports an error instead.
 *  - Bad values land in `errors` (never in `assignments`); "Paste the other values" is just
 *    staging the plan, "Cancel" is not staging it.
 *  - `limit`: 'refuse' above 100,000 cells (plan comes back empty), 'confirm' above 10,000.
 *  - Rows below the last grid row: `extraRows` (the "Add N new rows?" dialog; dropped, counted
 *    in `droppedRows`, when `canAddRows` is false). `asNewRows` (Mod+Shift+V) puts every row in
 *    `newRows` instead. Errors for those rows use row = rowCount + index (or index for newRows).
 */

import type { ColumnMeta, Value } from "../../../lib/ipc/drivers";
import { READ_ONLY_KINDS, parseEdit } from "../../table-editor/editValue";
import { valueText } from "../../console/valueFormat";
import type { InterpretFormat } from "./detect";

export const CONFIRM_CELLS = 10_000;
export const REFUSE_CELLS = 100_000;

export type Cell = string | Value;

export interface PasteColumn {
  name: string;
  kind: ColumnMeta["kind"];
  nullable: boolean | null;
  /** False for read-only columns (keys it can't edit, computed, derived). */
  editable: boolean;
}

export interface PasteSelection {
  row: number;
  col: number;
  rows: number;
  cols: number;
}

export interface PlanOptions {
  /** Rows currently in the grid (loaded plus staged inserts). */
  rowCount: number;
  /** The first row of `table` is a header (use `detect().hasHeader`). */
  hasHeader?: boolean;
  /** Rows beyond the grid may become new rows. */
  canAddRows?: boolean;
  /** Mod+Shift+V: every row is a new row. */
  asNewRows?: boolean;
  /** The format the table was parsed with; `semicolon` accepts decimal commas ("1,5"). */
  format?: InterpretFormat | "typed";
}

export interface PasteAssignment {
  row: number;
  col: number;
  value: Value;
}

export interface PasteNewRow {
  cells: { col: number; value: Value }[];
}

export interface PasteError {
  /** Grid row index (0-based; add 1 for display). */
  row: number;
  col: number;
  column: string;
  raw: string;
  reason: string;
  /** E.g. `Row 3, total: 'abc' is not a number`. */
  message: string;
}

export interface PastePlan {
  assignments: PasteAssignment[];
  skippedColumns: { col: number; name: string }[];
  errors: PasteError[];
  extraRows: PasteNewRow[];
  newRows?: PasteNewRow[];
  limit: "confirm" | "refuse" | null;
  /** Cells the paste targets, skipped and invalid ones included. */
  cells: number;
  /** Source rows / columns, for "Pasted <r> rows × <c> columns". */
  rowsPasted: number;
  colsPasted: number;
  /** Source rows that land on existing grid rows (the M of "Paste M rows only"). */
  rowsFit: number;
  mapping: "header" | "position";
  /** Header names that matched no column (header mapping only). */
  unmatchedHeaders: string[];
  /** Source columns that fell off the right edge of the grid. */
  droppedColumns: number;
  /** Rows dropped because new rows are not allowed. */
  droppedRows: number;
}

const INT_KINDS = new Set(["int", "bigint", "float", "decimal"]);
/** The kinds `parseEdit` stores as plain text (its default branch). */
const TYPED_KINDS = new Set([
  "int",
  "bigint",
  "float",
  "decimal",
  "bool",
  "json",
  "date",
  "time",
  "timestamp",
  "timestamptz",
  "uuid",
]);
const isTextLike = (k: string) => !TYPED_KINDS.has(k);

const NULL_VALUE: Value = { kind: "null" };

/** Turn the parser's message into the tail of "Row 3, total: 'abc' is not a number". */
function phrase(reason: string): string {
  if (reason === "Enter a whole number") return "is not a whole number";
  if (reason === "Enter a number") return "is not a number";
  if (reason === "Enter true or false") return "is not true or false";
  if (reason === "Enter a value") return "is empty";
  if (reason.startsWith("Not valid JSON")) return `is not valid JSON (${reason.slice(16)})`;
  return `can't be used: ${reason}`;
}

type Converted = { ok: true; value: Value } | { ok: false; reason: string };

function convert(col: PasteColumn, cell: Cell, decimalComma: boolean): Converted {
  const notNull = col.nullable === false;
  const nul = (): Converted =>
    notNull
      ? { ok: false, reason: "is empty (column does not allow NULL)" }
      : { ok: true, value: NULL_VALUE };
  let raw: string;
  if (typeof cell === "string") raw = cell;
  else {
    if (cell.kind === "null") return nul();
    if (cell.kind === col.kind) return { ok: true, value: cell };
    raw = valueText(cell) ?? "";
  }
  if (isTextLike(col.kind)) {
    if (typeof cell === "string" && raw === "NULL") return nul();
    const p = parseEdit(col, raw);
    return p.ok ? { ok: true, value: p.value } : { ok: false, reason: p.error };
  }
  const t = raw.trim();
  if (t === "" || (col.kind === "json" ? raw === "NULL" : t.toUpperCase() === "NULL")) return nul();
  if (decimalComma && INT_KINDS.has(col.kind) && /^[+-]?\d+,\d+$/.test(t))
    raw = t.replace(",", ".");
  const p = parseEdit(col, raw);
  return p.ok ? { ok: true, value: p.value } : { ok: false, reason: phrase(p.error) };
}

const clip = (s: string) => (s.length > 40 ? `${s.slice(0, 40)}…` : s);
const rawOf = (c: Cell) => (typeof c === "string" ? c : (valueText(c) ?? "NULL"));

interface Target {
  /** Source row / column in the table (after the header is removed). */
  i: number;
  j: number;
  /** Grid row / column. */
  gr: number;
  gc: number;
}

export function plan(
  table: Cell[][],
  selection: PasteSelection,
  columns: PasteColumn[],
  editable: boolean,
  opts: PlanOptions,
): PastePlan {
  let rows = table;
  let header: string[] | null = null;
  if (opts.hasHeader && rows.length > 0) {
    header = rows[0].map((c) => (typeof c === "string" ? c : (valueText(c) ?? "")));
    rows = rows.slice(1);
  }
  const R = rows.length;
  const C = rows.reduce((m, r) => Math.max(m, r.length), 0);

  // Column mapping.
  let mapping: PastePlan["mapping"] = "position";
  const colOf: number[] = [];
  const unmatchedHeaders: string[] = [];
  if (header) {
    const byName = new Map<string, number>();
    columns.forEach((c, i) => {
      const k = c.name.trim().toLowerCase();
      if (!byName.has(k)) byName.set(k, i);
    });
    const found = header.map((h) => byName.get(h.trim().toLowerCase()) ?? -1);
    if (found.some((x) => x >= 0)) {
      mapping = "header";
      found.forEach((x, j) => {
        colOf[j] = x;
        if (x < 0) unmatchedHeaders.push(header![j]);
      });
    }
  }

  const sel = {
    row: selection.row,
    col: selection.col,
    rows: Math.max(1, selection.rows),
    cols: Math.max(1, selection.cols),
  };
  const bigSel = sel.rows > 1 || sel.cols > 1;
  const fill = mapping === "position" && !opts.asNewRows && R === 1 && C === 1 && bigSel;
  const tile =
    mapping === "position" &&
    !opts.asNewRows &&
    !fill &&
    R > 0 &&
    C > 0 &&
    bigSel &&
    sel.rows % R === 0 &&
    sel.cols % C === 0;

  const mappedCols = mapping === "header" ? colOf.filter((x) => x >= 0).length : C;
  const cells = fill || tile ? sel.rows * sel.cols : R * mappedCols;

  const result: PastePlan = {
    assignments: [],
    skippedColumns: [],
    errors: [],
    extraRows: [],
    limit: cells > REFUSE_CELLS ? "refuse" : cells > CONFIRM_CELLS ? "confirm" : null,
    cells,
    rowsPasted: R,
    colsPasted: mappedCols,
    rowsFit: 0,
    mapping,
    unmatchedHeaders,
    droppedColumns: 0,
    droppedRows: 0,
  };
  if (opts.asNewRows) result.newRows = [];
  if (result.limit === "refuse" || cells === 0) return result;

  function* targets(): Generator<Target> {
    if (fill || tile) {
      for (let r = 0; r < sel.rows; r++)
        for (let c = 0; c < sel.cols; c++)
          yield {
            i: fill ? 0 : r % R,
            j: fill ? 0 : c % C,
            gr: sel.row + r,
            gc: sel.col + c,
          };
      return;
    }
    for (let i = 0; i < R; i++)
      for (let j = 0; j < (mapping === "header" ? colOf.length : C); j++) {
        const gc = mapping === "header" ? colOf[j] : sel.col + j;
        if (gc < 0) continue;
        yield { i, j, gr: sel.row + i, gc };
      }
  }

  const decimalComma = opts.format === "semicolon";
  const skipped = new Map<number, string>();
  const dropped = new Set<number>();
  const fit = new Set<number>();
  const droppedRows = new Set<number>();

  for (const t of targets()) {
    const cell = rows[t.i][t.j];
    if (cell === undefined) continue;
    if (t.gc >= columns.length) {
      dropped.add(t.j);
      continue;
    }
    const col = columns[t.gc];
    if (!editable || !col.editable || READ_ONLY_KINDS.has(col.kind)) {
      skipped.set(t.gc, col.name);
      continue;
    }
    const isNew = !!opts.asNewRows;
    const extra = !isNew && t.gr >= opts.rowCount;
    if (extra && !opts.canAddRows) {
      droppedRows.add(t.i);
      continue;
    }
    if (!isNew && !extra) fit.add(t.gr);
    const outRow = isNew ? t.i : extra ? t.gr - opts.rowCount : -1;
    const errRow = isNew ? t.i : t.gr;
    const conv = convert(col, cell, decimalComma);
    if (!conv.ok) {
      const reason = conv.reason;
      result.errors.push({
        row: errRow,
        col: t.gc,
        column: col.name,
        raw: rawOf(cell),
        reason,
        message: `Row ${errRow + 1}, ${col.name}: '${clip(rawOf(cell))}' ${reason}`,
      });
      continue;
    }
    if (isNew || extra) {
      const list = isNew ? result.newRows! : result.extraRows;
      while (list.length <= outRow) list.push({ cells: [] });
      list[outRow].cells.push({ col: t.gc, value: conv.value });
    } else {
      result.assignments.push({ row: t.gr, col: t.gc, value: conv.value });
    }
  }
  result.rowsFit = fit.size;
  result.droppedColumns = dropped.size;
  result.droppedRows = droppedRows.size;
  result.skippedColumns = [...skipped]
    .map(([col, name]) => ({ col, name }))
    .sort((a, b) => a.col - b.col);
  return result;
}
