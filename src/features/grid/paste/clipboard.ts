/**
 * Clipboard payloads (pure, no React).
 *
 * Contract:
 *  - Copy: `buildCopy(columns, rows)` returns `{ text, typed }`. Write `text` as `text/plain`
 *    (TSV, Excel-style quoting, NULL as empty, no header unless `headers`) and `typed` under
 *    `CELLS_MIME` (`application/x-clew-cells+json`). The typed payload keeps NULL vs '' and exact
 *    decimals; it carries no header.
 *  - Paste: `readPaste(text, typed)` returns the typed rows when the private payload is present,
 *    well formed and matches the shape of the text; otherwise it falls back to the text.
 *  - `toInput(source, columns)` yields what `plan` takes: `{ table, hasHeader, format }` where
 *    typed pastes use format 'typed' (label it "Clew") and never have a header, text pastes go
 *    through `detect` (or `interpretAs` when `forceFormat` is given).
 */

import type { Value } from "../../../lib/ipc/drivers";
import { valueText } from "../../console/valueFormat";
import { detect, interpretAs, parseDelimited } from "./detect";
import type { InterpretFormat } from "./detect";
import type { Cell } from "./plan";

export const CELLS_MIME = "application/x-clew-cells+json";

export interface CellsPayload {
  version: 1;
  columns?: string[];
  rows: Value[][];
}

const tsvCell = (s: string | null) =>
  s !== null && /[\t\r\n"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : (s ?? "");

export function buildCopy(
  columns: string[],
  rows: Value[][],
  opts: { headers?: boolean } = {},
): { text: string; typed: string } {
  const lines: string[] = [];
  if (opts.headers) lines.push(columns.map(tsvCell).join("\t"));
  for (const r of rows) lines.push(r.map((v) => tsvCell(valueText(v))).join("\t"));
  const payload: CellsPayload = { version: 1, rows, ...(opts.headers ? { columns } : {}) };
  return {
    text: lines.join("\r\n") + (lines.length ? "\r\n" : ""),
    typed: JSON.stringify(payload),
  };
}

export type PasteSource =
  | { kind: "typed"; text: string; rows: Value[][]; columns?: string[] }
  | { kind: "text"; text: string };

const isValue = (v: unknown): v is Value =>
  typeof v === "object" && v !== null && typeof (v as { kind?: unknown }).kind === "string";

function parseTyped(typed: string): CellsPayload | null {
  try {
    const p = JSON.parse(typed) as Partial<CellsPayload>;
    if (p.version !== 1 || !Array.isArray(p.rows)) return null;
    if (!p.rows.every((r) => Array.isArray(r) && r.every(isValue))) return null;
    return p as CellsPayload;
  } catch {
    return null;
  }
}

export function readPaste(text: string, typed?: string | null): PasteSource {
  if (typed) {
    const p = parseTyped(typed);
    if (p) {
      const grid = text === "" ? [[""]] : parseDelimited(text, "\t");
      const width = (rows: unknown[][]) => rows.reduce((m, r) => Math.max(m, r.length), 0);
      const withHeader = p.columns ? 1 : 0;
      if (grid.length === p.rows.length + withHeader && width(grid) === width(p.rows))
        return { kind: "typed", text, rows: p.rows, columns: p.columns };
    }
  }
  return { kind: "text", text };
}

export interface PasteInput {
  table: Cell[][];
  hasHeader: boolean;
  format: InterpretFormat | "typed";
  error?: string;
}

export function toInput(
  source: PasteSource,
  columns?: string[],
  forceFormat?: InterpretFormat,
): PasteInput {
  if (source.kind === "typed" && !forceFormat) {
    if (source.columns)
      return { table: [source.columns, ...source.rows], hasHeader: true, format: "typed" };
    return { table: source.rows, hasHeader: false, format: "typed" };
  }
  const d = forceFormat
    ? interpretAs(source.text, forceFormat, columns)
    : detect(source.text, columns);
  return { table: d.table, hasHeader: d.hasHeader, format: d.format, error: d.error };
}
