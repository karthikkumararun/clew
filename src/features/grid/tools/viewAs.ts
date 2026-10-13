/**
 * Contract: data builders for View as Tree and Text, with Transpose, and the extractor options
 * shared by Copy as, Copy, Export and the Text view (spec: data-grid › View as, Extractor
 * options). `applyExtractorOptions` drops computed / generated columns and applies the date
 * format; `formatExtract` writes the result with the existing formatters (valueFormat.ts,
 * copyFormats.ts) so Text matches Copy as; `toTree` yields EJSON documents that the document
 * browser's tree model (`flattenDocs`) renders with type colours. Options are remembered per
 * format via `ExtractorStore`. Pure and framework-free.
 */
import type { ColumnMeta, Value } from "../../../lib/ipc/drivers";
import { toCsv, toJson, toTsv, valueText } from "../../console/valueFormat";
import type { EJson } from "../../documents/ejson";
import { toInserts, toMarkdown } from "../copyFormats";
import type { GridSource } from "../source";
import type { SqlFlavor } from "../sqlLiteral";
import { decode } from "./valueCodec";
import type { DisplayAs } from "./valueCodec";

export type ExtractorFormat = "csv" | "tsv" | "markdown" | "json" | "jsonl" | "insert";
export const EXTRACTOR_FORMATS: readonly ExtractorFormat[] = [
  "csv",
  "tsv",
  "markdown",
  "json",
  "jsonl",
  "insert",
];

export type DateFormat = Extract<
  DisplayAs,
  "default" | "iso8601" | "us" | "eu" | "epoch-s" | "epoch-ms"
>;

export interface ExtractorOptions {
  format: ExtractorFormat;
  /** Header row (csv, tsv). Markdown always has one; JSON and INSERT name the columns anyway. */
  header: boolean;
  /** CSV field delimiter. */
  delimiter: string;
  /** CSV quoting: only when needed, or every field. */
  quote: "needed" | "always";
  /** How NULL is written in csv, tsv and markdown. */
  nullText: string;
  dateFormat: DateFormat;
  skipComputed: boolean;
  skipGenerated: boolean;
  /** Already-quoted table for INSERT. */
  table: string;
  flavor: SqlFlavor;
}

export function defaultExtractorOptions(format: ExtractorFormat): ExtractorOptions {
  return {
    format,
    header: true,
    delimiter: format === "tsv" ? "\t" : ",",
    quote: "needed",
    nullText: format === "markdown" ? "NULL" : "",
    dateFormat: "default",
    skipComputed: false,
    skipGenerated: false,
    table: "table_name",
    flavor: "standard",
  };
}

/** Options remembered per format. */
export type ExtractorStore = Record<ExtractorFormat, ExtractorOptions>;

export function defaultExtractorStore(): ExtractorStore {
  return Object.fromEntries(
    EXTRACTOR_FORMATS.map((f) => [f, defaultExtractorOptions(f)]),
  ) as ExtractorStore;
}

export const optionsFor = (store: ExtractorStore, format: ExtractorFormat): ExtractorOptions =>
  store[format];

/** Store the options under their own format (returns a new store). */
export function rememberOptions(store: ExtractorStore, opts: ExtractorOptions): ExtractorStore {
  return { ...store, [opts.format]: opts };
}

/** A result column with what the edit plan knows about it. */
export interface ExtractorColumn extends ColumnMeta {
  /** An expression with no source column (like `with_tax`). Inferred from provenance when unset. */
  computed?: boolean;
  /** Generated or identity-always by the database. */
  generated?: boolean;
}

export interface ExtractorData {
  columns: ExtractorColumn[];
  rows: Value[][];
}

export function isComputedColumn(col: ExtractorColumn, all: readonly ExtractorColumn[]): boolean {
  if (col.computed !== undefined) return col.computed;
  return all.some((c) => c.source_column) && !col.source_column;
}

export const isGeneratedColumn = (col: ExtractorColumn): boolean => col.generated === true;

export interface Extracted {
  columns: ExtractorColumn[];
  names: string[];
  rows: Value[][];
  /** Source column index of each kept column. */
  kept: number[];
}

const DATE_KINDS = new Set(["date", "timestamp", "timestamptz"]);

/** Apply "Skip computed columns", "Skip generated columns" and the date format. */
export function applyExtractorOptions(data: ExtractorData, opts: ExtractorOptions): Extracted {
  const kept: number[] = [];
  data.columns.forEach((c, i) => {
    if (opts.skipComputed && isComputedColumn(c, data.columns)) return;
    if (opts.skipGenerated && isGeneratedColumn(c)) return;
    kept.push(i);
  });
  const reformat = (v: Value): Value => {
    if (opts.dateFormat === "default" || !DATE_KINDS.has(v.kind)) return v;
    const d = decode(v, opts.dateFormat);
    return d.ok ? { kind: "text", value: d.text } : v;
  };
  return {
    columns: kept.map((i) => data.columns[i]),
    names: kept.map((i) => data.columns[i].name),
    rows: data.rows.map((r) => kept.map((i) => reformat(r[i] ?? { kind: "null" }))),
    kept,
  };
}

const csvField = (s: string, o: ExtractorOptions) =>
  o.quote === "always" || s.includes(o.delimiter) || /["\r\n]/.test(s)
    ? `"${s.replace(/"/g, '""')}"`
    : s;

const withNullText = (rows: Value[][], nullText: string): Value[][] =>
  rows.map((r) => r.map((v) => (v.kind === "null" ? { kind: "text", value: nullText } : v)));

/** The data written in the chosen format. */
export function formatExtract(data: ExtractorData, opts: ExtractorOptions): string {
  const x = applyExtractorOptions(data, opts);
  switch (opts.format) {
    case "csv": {
      const text = (v: Value) => csvField(valueText(v) ?? opts.nullText, opts);
      if (opts.delimiter === "," && opts.quote === "needed" && opts.header) {
        return toCsv(x.names, withNullText(x.rows, opts.nullText));
      }
      const lines = opts.header ? [x.names.map((n) => csvField(n, opts)).join(opts.delimiter)] : [];
      for (const r of x.rows) lines.push(r.map(text).join(opts.delimiter));
      return lines.join("\r\n") + "\r\n";
    }
    case "tsv": {
      const text = toTsv(x.names, withNullText(x.rows, opts.nullText));
      return opts.header ? text : text.slice(text.indexOf("\n") + 1);
    }
    case "markdown":
      return toMarkdown(x.names, withNullText(x.rows, opts.nullText));
    case "json":
      return toJson(x.names, x.rows);
    case "jsonl":
      return (
        (JSON.parse(toJson(x.names, x.rows)) as unknown[])
          .map((o) => JSON.stringify(o))
          .join("\n") + "\n"
      );
    case "insert":
      return toInserts(opts.flavor, opts.table, x.names, x.rows);
  }
}

// ---- Transpose -------------------------------------------------------------------------------

/**
 * Rows become columns: one line per column; one value column per row (named "value" for a
 * single row, "#1", "#2"… for several). `limit` caps how many rows are laid out.
 */
export function transposeData(data: ExtractorData, limit = Infinity): ExtractorData {
  const shown = Math.min(data.rows.length, limit);
  const text = (name: string): ExtractorColumn => ({
    name,
    type_name: "",
    kind: "text",
    nullable: null,
  });
  return {
    columns: [
      text("column"),
      ...Array.from({ length: shown }, (_, i) => text(shown === 1 ? "value" : `#${i + 1}`)),
    ],
    rows: data.columns.map((c, ci) => [
      { kind: "text", value: c.name } as Value,
      ...Array.from({ length: shown }, (_, ri) => data.rows[ri][ci] ?? ({ kind: "null" } as Value)),
    ]),
  };
}

export interface TextOptions {
  extractor: ExtractorOptions;
  transpose?: boolean;
  /** Cap on rows in a transposed layout (default 50, like the grid). */
  transposeLimit?: number;
}

/** The Text view: all rows as text in the extractor format, transposed when asked. */
export function toText(rows: Value[][], columns: ExtractorColumn[], options: TextOptions): string {
  let data: ExtractorData = { columns, rows };
  if (options.transpose) {
    // Skip flags apply to the source columns, before they become lines.
    const x = applyExtractorOptions(data, {
      ...options.extractor,
      dateFormat: "default",
    });
    data = transposeData({ columns: x.columns, rows: x.rows }, options.transposeLimit ?? 50);
    return formatExtract(data, {
      ...options.extractor,
      skipComputed: false,
      skipGenerated: false,
    });
  }
  return formatExtract(data, options.extractor);
}

/** Cells of the chosen store rows and columns (the selection, or one row) as extractor data. */
export function pickData(
  source: GridSource,
  columns: ExtractorColumn[],
  storeRows: ArrayLike<number>,
  cols: readonly number[] = columns.map((_, i) => i),
): ExtractorData {
  return {
    columns: cols.map((c) => columns[c]),
    rows: Array.from({ length: storeRows.length }, (_, i) =>
      cols.map((c) => source.get(c, storeRows[i])),
    ),
  };
}

// ---- Tree ------------------------------------------------------------------------------------

function ms(value: string): number | null {
  const m =
    /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(
      value.trim(),
    );
  if (!m) return null;
  let tz = 0;
  if (m[8] && m[8] !== "Z") {
    const t = /^([+-])(\d{2}):?(\d{2})?$/.exec(m[8]) as RegExpExecArray;
    tz = (t[1] === "-" ? -1 : 1) * (Number(t[2]) * 60 + Number(t[3] ?? 0)) * 60_000;
  }
  const frac = m[7] ? Math.round(Number(`0${m[7]}`) * 1000) : 0;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0), frac) - tz;
}

/** A cell as Extended JSON, so the document tree shows its type and colour. */
export function valueToEJson(v: Value): EJson {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
    case "float":
      return v.value;
    case "int":
      return Math.abs(v.value) < 2 ** 31
        ? { $numberInt: String(v.value) }
        : { $numberLong: String(v.value) };
    case "bigint":
      return { $numberLong: v.value };
    case "decimal":
      return { $numberDecimal: v.value };
    case "text":
    case "date":
    case "time":
    case "interval":
    case "other":
      return v.value;
    case "timestamp":
    case "timestamptz": {
      const t = ms(v.value);
      return t === null ? v.value : { $date: { $numberLong: String(t) } };
    }
    case "uuid": {
      const hex = v.value.replace(/-/g, "");
      if (!/^[0-9a-fA-F]{32}$/.test(hex)) return v.value;
      const bin = String.fromCharCode(...(hex.match(/../g) ?? []).map((h) => parseInt(h, 16)));
      return { $binary: { base64: btoa(bin), subType: "04" } };
    }
    case "bytes": {
      const bin = String.fromCharCode(...(v.value.match(/../g) ?? []).map((h) => parseInt(h, 16)));
      return { $binary: { base64: btoa(bin), subType: "00" } };
    }
    case "json":
      return v.value as EJson;
    case "array":
      return v.value.map(valueToEJson);
    case "node":
      return `(${v.labels.map((l) => `:${l}`).join("")} ${v.elementId})`;
    case "relationship":
      return `[:${v.relType} ${v.elementId}]`;
    case "path":
      return `<path ${v.nodes.length} nodes>`;
  }
}

export interface TreeOptions {
  extractor?: ExtractorOptions;
  /** Roots are columns, each holding one entry per row, instead of one root per row. */
  transpose?: boolean;
  /** First row number shown in titles (default 1). */
  firstRow?: number;
  /** Cap on rows in a transposed layout (default 50). */
  transposeLimit?: number;
}

export interface TreeData {
  /** One document per root, for `flattenDocs`. */
  docs: EJson[];
  /** Root titles: "Row 3", or the column name when transposed. */
  titles: string[];
  /** Stable key per document, for `flattenDocs`' docKeyOf. */
  keyOf: (doc: EJson) => string;
}

const uniqueName = (name: string, used: Set<string>) => {
  let n = name;
  for (let i = 2; used.has(n); i++) n = `${name} (${i})`;
  used.add(n);
  return n;
};

/** Each row's values as a key-value document (JSON, arrays and structured types expand in place). */
export function toTree(
  rows: Value[][],
  columns: ExtractorColumn[],
  options: TreeOptions = {},
): TreeData {
  const ex = options.extractor ?? defaultExtractorOptions("csv");
  // Typed values stay typed: only the column skip applies to the tree.
  const x = applyExtractorOptions({ columns, rows }, { ...ex, dateFormat: "default" });
  const first = options.firstRow ?? 1;
  const docs: EJson[] = [];
  const titles: string[] = [];
  if (options.transpose) {
    const shown = Math.min(rows.length, options.transposeLimit ?? 50);
    x.names.forEach((name, ci) => {
      const doc: { [k: string]: EJson } = {};
      for (let ri = 0; ri < shown; ri++) {
        doc[shown === 1 ? "value" : `#${first + ri}`] = valueToEJson(x.rows[ri][ci]);
      }
      docs.push(doc);
      titles.push(name);
    });
  } else {
    x.rows.forEach((r, ri) => {
      const used = new Set<string>();
      const doc: { [k: string]: EJson } = {};
      r.forEach((v, ci) => {
        doc[uniqueName(x.names[ci], used)] = valueToEJson(v);
      });
      docs.push(doc);
      titles.push(`Row ${first + ri}`);
    });
  }
  const keys = new Map<EJson, string>(
    docs.map((d, i) => [d, `${options.transpose ? "col" : "row"}-${i}`]),
  );
  return { docs, titles, keyOf: (d) => keys.get(d) ?? "?" };
}
