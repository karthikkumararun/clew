import type { Value } from "../../lib/ipc/drivers";
import { toCsv, toJson, toTsv, valueText } from "../console/valueFormat";
import { quoteIdent, sqlLiteral } from "./sqlLiteral";
import type { SqlFlavor } from "./sqlLiteral";

export type CopyFormat = "tsv" | "csv" | "json" | "markdown" | "insert";

export interface CopyData {
  columns: string[];
  rows: Value[][];
}

const mdCell = (s: string | null) =>
  (s ?? "NULL").replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, "<br>");

/** A GitHub-style Markdown table. */
export function toMarkdown(columns: string[], rows: Value[][]): string {
  const head = `| ${columns.map(mdCell).join(" | ")} |`;
  const rule = `| ${columns.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.map((v) => mdCell(valueText(v))).join(" | ")} |`);
  return [head, rule, ...body].join("\n") + "\n";
}

/** One `INSERT` per row, with identifiers and literals written for the dialect. */
export function toInserts(
  flavor: SqlFlavor,
  table: string,
  columns: string[],
  rows: Value[][],
): string {
  const cols = columns.map((c) => quoteIdent(flavor, c)).join(", ");
  return (
    rows
      .map(
        (r) =>
          `INSERT INTO ${table} (${cols}) VALUES (${r.map((v) => sqlLiteral(flavor, v)).join(", ")});`,
      )
      .join("\n") + "\n"
  );
}

export interface CopyOptions {
  flavor: SqlFlavor;
  /** Already-quoted table name for INSERT statements. */
  table: string;
  /** Include the header row for TSV (Mod+C copies without by default). */
  headers?: boolean;
}

export function format(data: CopyData, as: CopyFormat, o: CopyOptions): string {
  switch (as) {
    case "tsv": {
      const text = toTsv(data.columns, data.rows);
      return o.headers === false ? text.slice(text.indexOf("\n") + 1) : text;
    }
    case "csv":
      return toCsv(data.columns, data.rows);
    case "json":
      return toJson(data.columns, data.rows);
    case "markdown":
      return toMarkdown(data.columns, data.rows);
    case "insert":
      return toInserts(o.flavor, o.table, data.columns, data.rows);
  }
}
