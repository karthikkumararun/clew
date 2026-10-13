/**
 * Contract: pure helpers behind the grid options menu and Go to row / Related rows (spec:
 * data-grid › Grid options menu, Go to row and related rows). Statement text for View query and
 * Copy query to console / clipboard; Go to row parsing ("150" is a row number, `key: 42` or
 * `=42` is a key value, composite keys are comma separated) with clamping and key lookup over the
 * visible rows; and Related rows, which builds `SELECT * FROM <table> WHERE <fk> = <value>` from
 * foreign keys handed in as input, with per-dialect quoting from sqlLiteral.ts. No IPC here.
 */
import type { Value } from "../../../lib/ipc/drivers";
import { valueText } from "../../console/valueFormat";
import type { GridSource } from "../source";
import { quoteIdent, sqlLiteral } from "../sqlLiteral";
import type { SqlFlavor } from "../sqlLiteral";
import { compareNumeric, numericOf, parseDecimal } from "./decimal";

// ---- View query / Copy query -----------------------------------------------------------------

/** The statement as shown in View query: trimmed, one trailing semicolon. */
export function viewQueryText(statement: string): string {
  const t = statement.trim().replace(/[;\s]+$/, "");
  return t ? `${t};` : "";
}

/** What Copy query to console / clipboard puts in front of the user: same text, ends in a newline. */
export function copyQueryText(statement: string): string {
  const t = viewQueryText(statement);
  return t ? `${t}\n` : "";
}

export interface TableRef {
  schema?: string | null;
  name: string;
}

/** `"public"."orders"` with the dialect's quoting. */
export function qualifiedName(flavor: SqlFlavor, table: TableRef): string {
  return (
    (table.schema ? `${quoteIdent(flavor, table.schema)}.` : "") + quoteIdent(flavor, table.name)
  );
}

export interface SelectParts {
  flavor: SqlFlavor;
  table: TableRef;
  columns?: string[];
  where?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}

/** A SELECT with the dialect's row limiting (LIMIT, or OFFSET … FETCH for SQL Server and Oracle). */
export function selectSql(p: SelectParts): string {
  const cols = p.columns?.length ? p.columns.map((c) => quoteIdent(p.flavor, c)).join(", ") : "*";
  let sql = `SELECT ${cols} FROM ${qualifiedName(p.flavor, p.table)}`;
  if (p.where?.trim()) sql += ` WHERE ${p.where.trim()}`;
  const order = p.orderBy?.trim();
  if (order) sql += ` ORDER BY ${order}`;
  if (p.limit !== undefined) {
    const offset = p.offset ?? 0;
    if (p.flavor === "sqlserver") {
      sql += `${order ? "" : " ORDER BY (SELECT NULL)"} OFFSET ${offset} ROWS FETCH NEXT ${p.limit} ROWS ONLY`;
    } else if (p.flavor === "oracle") {
      sql += ` OFFSET ${offset} ROWS FETCH NEXT ${p.limit} ROWS ONLY`;
    } else {
      sql += ` LIMIT ${p.limit}${offset ? ` OFFSET ${offset}` : ""}`;
    }
  }
  return `${sql};`;
}

// ---- Go to row -------------------------------------------------------------------------------

export type GoToTarget =
  | {
      kind: "row";
      /** 0-based row among the displayed rows. */
      row: number;
      /** The number the user typed (1-based) differs from `row + 1` when it was clamped. */
      clamped: boolean;
    }
  | { kind: "key"; values: string[] };

export type GoToParse = { ok: true; target: GoToTarget } | { ok: false; error: string };

const unquote = (s: string) => {
  const t = s.trim();
  return /^'.*'$|^".*"$/.test(t) ? t.slice(1, -1) : t;
};

/**
 * Parse the Go to row box. A whole number (optionally with `#` or `row `) is a row number,
 * counted from 1 and clamped to the loaded rows. A key is written `key: 42`, `=42` or, for a
 * composite key, `key: 7, 'a'`. Without key columns only row numbers are accepted.
 */
export function parseGoTo(
  input: string,
  opts: { rowCount: number; keyColumns?: number },
): GoToParse {
  const text = input.trim();
  if (!text) return { ok: false, error: "Enter a row number or a key" };
  const key = /^(?:key\s*:|=)\s*(.+)$/i.exec(text);
  if (key) {
    if (!opts.keyColumns) return { ok: false, error: "This result has no key to look up" };
    const values = splitKey(key[1]);
    if (values.length !== opts.keyColumns) {
      return {
        ok: false,
        error: `The key has ${opts.keyColumns} ${opts.keyColumns === 1 ? "column" : "columns"}; got ${values.length} ${values.length === 1 ? "value" : "values"}`,
      };
    }
    return { ok: true, target: { kind: "key", values } };
  }
  const n = /^(?:#|row\s+)?(\d+)$/i.exec(text);
  if (!n) {
    return {
      ok: false,
      error: opts.keyColumns
        ? "Enter a row number, or key: <value> to find a key"
        : "Enter a row number",
    };
  }
  if (opts.rowCount <= 0) return { ok: false, error: "There are no rows" };
  const wanted = Number(n[1]);
  const row = Math.min(Math.max(wanted, 1), opts.rowCount);
  return { ok: true, target: { kind: "row", row: row - 1, clamped: row !== wanted } };
}

function splitKey(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote = "";
  for (const ch of text) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = "";
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === ",") {
      out.push(unquote(cur));
      cur = "";
    } else cur += ch;
  }
  out.push(unquote(cur));
  return out;
}

/** Does the cell equal the typed key part? Numbers compare exactly, everything else as text. */
export function cellEqualsKey(v: Value, typed: string): boolean {
  const n = numericOf(v);
  if (n) {
    const d = parseDecimal(typed);
    return d !== null && compareNumeric(n, { exact: d }) === 0;
  }
  return valueText(v) === typed;
}

/**
 * The displayed row whose key columns equal the typed values, or -1. `visible` is the
 * `visibleRows` index (null: identity); `keyColumns` are source column indexes.
 */
export function findRowByKey(
  source: GridSource,
  visible: ArrayLike<number> | null,
  keyColumns: readonly number[],
  values: readonly string[],
): number {
  const n = visible ? visible.length : source.rowCount;
  for (let row = 0; row < n; row++) {
    const store = visible ? visible[row] : row;
    if (keyColumns.every((c, i) => cellEqualsKey(source.get(c, store), values[i]))) return row;
  }
  return -1;
}

// ---- Related rows ----------------------------------------------------------------------------

export type RelatedResult =
  { ok: true; sql: string; table: TableRef } | { ok: false; reason: string };

/** `SELECT * FROM <table> WHERE a = 1 AND b = 'x'` for the given columns and values. */
export function relatedSelect(
  flavor: SqlFlavor,
  table: TableRef,
  columns: readonly string[],
  values: readonly Value[],
  limit?: number,
): RelatedResult {
  if (columns.length === 0 || columns.length !== values.length) {
    return { ok: false, reason: "The foreign key and the row do not line up" };
  }
  if (values.some((v) => v.kind === "null")) {
    return { ok: false, reason: "The foreign key is NULL, so there are no related rows" };
  }
  const where = columns
    .map((c, i) => `${quoteIdent(flavor, c)} = ${sqlLiteral(flavor, values[i])}`)
    .join(" AND ");
  return { ok: true, table, sql: selectSql({ flavor, table, where, limit }) };
}

/** A foreign key of the result's table, as `ForeignKeyDetail` describes it. */
export interface ForeignKeyInput {
  columns: readonly string[];
  refSchema?: string | null;
  refTable: string;
  refColumns: readonly string[];
}

/** A foreign key of another table pointing here, as `ReferencedBy` describes it. */
export interface ReferencedByInput {
  schema?: string | null;
  table: string;
  /** Columns in the referencing (child) table. */
  columns: readonly string[];
  /** The columns of this (parent) table they point at. */
  refColumns: readonly string[];
}

/**
 * From a foreign key cell: the referenced parent row(s), `SELECT * FROM parent WHERE pk = <fk
 * value>`. `rowValue(column)` reads the clicked row's value by column name.
 */
export function referencedRows(
  flavor: SqlFlavor,
  fk: ForeignKeyInput,
  rowValue: (column: string) => Value | undefined,
): RelatedResult {
  const values = fk.columns.map((c) => rowValue(c));
  if (values.some((v) => v === undefined)) {
    return { ok: false, reason: "The foreign key column is not in this result" };
  }
  return relatedSelect(
    flavor,
    { schema: fk.refSchema, name: fk.refTable },
    fk.refColumns,
    values as Value[],
  );
}

/**
 * From a key cell: the child rows that reference it, `SELECT * FROM child WHERE fk = <key
 * value>`.
 */
export function referencingRows(
  flavor: SqlFlavor,
  by: ReferencedByInput,
  rowValue: (column: string) => Value | undefined,
): RelatedResult {
  const values = by.refColumns.map((c) => rowValue(c));
  if (values.some((v) => v === undefined)) {
    return { ok: false, reason: "The referenced key column is not in this result" };
  }
  return relatedSelect(
    flavor,
    { schema: by.schema, name: by.table },
    by.columns,
    values as Value[],
  );
}
