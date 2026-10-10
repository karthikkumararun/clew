import type { Value } from "../../lib/ipc/drivers";

/** A cell's text, as shown in the table and written to CSV (NULL is `null`). */
export function valueText(v: Value): string | null {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
      return v.value ? "true" : "false";
    case "int":
    case "float":
      return String(v.value);
    case "bigint":
    case "decimal":
    case "text":
    case "date":
    case "time":
    case "timestamp":
    case "timestamptz":
    case "interval":
    case "uuid":
      return v.value;
    case "bytes":
      return `<${v.len} bytes>`;
    case "json":
      return JSON.stringify(v.value);
    case "array":
      return `{${v.value.map((x) => valueText(x) ?? "NULL").join(",")}}`;
    case "other":
      return v.value;
  }
}

/** Colour token of a value kind, as in the canvas grid. */
export function valueColor(v: Value): string | undefined {
  switch (v.kind) {
    case "int":
    case "bigint":
    case "float":
    case "decimal":
      return "var(--syn-number)";
    case "bool":
      return "var(--syn-boolean)";
    case "date":
    case "time":
    case "timestamp":
    case "timestamptz":
    case "interval":
      return "var(--syn-date)";
    case "null":
      return "var(--syn-null)";
    default:
      return undefined;
  }
}

const csvCell = (s: string | null) =>
  s === null ? "" : /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;

/** RFC 4180 CSV with a header row. */
export function toCsv(columns: string[], rows: Value[][]): string {
  const lines = [columns.map((c) => csvCell(c)).join(",")];
  for (const r of rows) lines.push(r.map((v) => csvCell(valueText(v))).join(","));
  return lines.join("\r\n") + "\r\n";
}

/** Tab-separated, for pasting into a spreadsheet. */
export function toTsv(columns: string[], rows: Value[][]): string {
  const cell = (s: string | null) => (s ?? "").replace(/[\t\r\n]+/g, " ");
  const lines = [columns.map(cell).join("\t")];
  for (const r of rows) lines.push(r.map((v) => cell(valueText(v))).join("\t"));
  return lines.join("\n") + "\n";
}

function jsonValue(v: Value): unknown {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
    case "int":
    case "float":
      return v.value;
    case "json":
      return v.value;
    case "array":
      return v.value.map(jsonValue);
    default:
      return valueText(v);
  }
}

/** An array of objects keyed by column name. */
export function toJson(columns: string[], rows: Value[][]): string {
  const objects = rows.map((r) => Object.fromEntries(columns.map((c, i) => [c, jsonValue(r[i])])));
  return JSON.stringify(objects, null, 2) + "\n";
}
