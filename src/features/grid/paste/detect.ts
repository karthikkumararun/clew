/**
 * Paste format detection (pure, no React).
 *
 * Contract:
 *  - `detect(text, columns?)` guesses the format of clipboard text and returns the parsed table.
 *    `columns` are the grid's column names; a header row matching them (case-insensitive) is
 *    flagged `hasHeader`. The table is NOT stripped of its header row: `plan` does that.
 *  - `interpretAs(text, format, columns?)` re-parses with a user-chosen format (the "Interpret
 *    as" menu). It never throws. A JSON parse failure gives `table: []` and an `error`.
 *  - Table rows may be ragged (different lengths); width = longest row. Cells are strings; a
 *    JSON null or missing key becomes the string `NULL`.
 *  - Formats: JSON (array of objects / arrays / scalars), Markdown pipe table with a `---`
 *    rule line, then tab, comma, semicolon, pipe scored by field-count consistency over the
 *    first 50 records. Tab wins when consistent. Comma/semicolon/pipe need >= 2 records, so a
 *    one-line "Smith, John" stays one value. No delimiter found: `tsv` with one column.
 *  - RFC 4180 quoting for the delimited formats; CRLF, LF, CR, a trailing newline and a BOM are
 *    handled.
 */

export type DetectFormat = "json" | "markdown" | "tsv" | "csv" | "semicolon" | "pipe";
/** The "Interpret as" choices: the detectable formats plus "One value". */
export type InterpretFormat = DetectFormat | "single";

export interface Detected {
  format: InterpretFormat;
  /** The field delimiter ('' for JSON and One value). */
  delimiter: string;
  hasHeader: boolean;
  table: string[][];
  /** Set when a forced format could not be parsed. */
  error?: string;
}

/** Menu labels, in the order the spec lists them. */
export const FORMAT_LABELS: Record<InterpretFormat, string> = {
  tsv: "Tab-separated",
  csv: "CSV comma",
  semicolon: "CSV semicolon",
  pipe: "CSV pipe",
  markdown: "Markdown table",
  json: "JSON array",
  single: "One value",
};

const DELIMS: Record<"tsv" | "csv" | "semicolon" | "pipe", string> = {
  tsv: "\t",
  csv: ",",
  semicolon: ";",
  pipe: "|",
};
const SCAN_RECORDS = 50;
const MIN_CONSISTENCY = 0.5;

const stripBom = (s: string) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

/** RFC 4180 parser for a single-character delimiter. Stops after `maxRecords` records. */
export function parseDelimited(text: string, delimiter: string, maxRecords = Infinity): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let field = "";
  let started = false; // anything consumed in the current record
  let quoted = false; // current field was opened with a quote (so a later quote is literal)
  let inQ = false;
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else inQ = false;
      } else field += c;
      continue;
    }
    started = true;
    if (c === '"' && field === "" && !quoted) {
      inQ = true;
      quoted = true;
    } else if (c === delimiter) {
      row.push(field);
      field = "";
      quoted = false;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      out.push(row);
      if (out.length >= maxRecords) return out;
      row = [];
      field = "";
      quoted = false;
      started = false;
    } else field += c;
  }
  if (started || inQ) {
    row.push(field);
    out.push(row);
  }
  // A blank line at the end is not data.
  while (out.length > 1 && out[out.length - 1].length === 1 && out[out.length - 1][0] === "") {
    out.pop();
  }
  return out;
}

const NUMERIC = /^[+-]?(\d+([.,]\d+)?|\.\d+)(e[+-]?\d+)?$/i;
const isNumeric = (s: string) => NUMERIC.test(s.trim());

/** Does the first row look like a header? */
export function looksLikeHeader(table: string[][], columns?: string[]): boolean {
  if (table.length < 2) return false;
  const head = table[0].map((s) => s.trim());
  const filled = head.filter((s) => s !== "");
  if (filled.length === 0) return false;
  if (columns && columns.length > 0) {
    const names = new Set(columns.map((c) => c.trim().toLowerCase()));
    const hits = filled.filter((s) => names.has(s.toLowerCase())).length;
    if (hits > 0 && hits * 2 >= filled.length) return true;
  }
  return head.every((s) => s !== "" && !isNumeric(s)) && table[1].some((s) => isNumeric(s));
}

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "string") return v;
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function jsonTable(text: string): { table: string[][]; header: boolean } | null {
  const t = text.trim();
  if (!t.startsWith("[") && !t.startsWith("{")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  const items = Array.isArray(parsed) ? parsed : isObject(parsed) ? [parsed] : null;
  if (!items || items.length === 0) return null;
  if (items.every(isObject)) {
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const o of items)
      for (const k of Object.keys(o))
        if (!seen.has(k)) {
          seen.add(k);
          keys.push(k);
        }
    return {
      table: [keys, ...items.map((o) => keys.map((k) => cellText(o[k])))],
      header: true,
    };
  }
  if (items.every(Array.isArray)) {
    return { table: items.map((r) => (r as unknown[]).map(cellText)), header: false };
  }
  if (items.every((v) => !Array.isArray(v) && !isObject(v))) {
    return { table: items.map((v) => [cellText(v)]), header: false };
  }
  return null;
}

const MD_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function mdCells(line: string): string[] {
  const t = line.trim();
  const pieces: string[] = [];
  let cur = "";
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === "\\" && (t[i + 1] === "|" || t[i + 1] === "\\")) {
      cur += t[++i];
    } else if (c === "|") {
      pieces.push(cur);
      cur = "";
    } else cur += c;
  }
  pieces.push(cur);
  if (t.startsWith("|")) pieces.shift();
  if (t.endsWith("|") && !t.endsWith("\\|") && pieces.length > 0) pieces.pop();
  return pieces.map((s) => s.trim().replace(/<br\s*\/?>/gi, "\n"));
}

function markdownTable(
  text: string,
  strict: boolean,
): { table: string[][]; header: boolean } | null {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim() !== "");
  const ruled = lines.length >= 2 && lines[0].includes("|") && MD_RULE.test(lines[1]);
  if (strict && !ruled) return null;
  const table: string[][] = [];
  lines.forEach((l, i) => {
    if (ruled && i === 1) return;
    if (!ruled && MD_RULE.test(l)) return;
    table.push(mdCells(l));
  });
  return { table, header: ruled };
}

function score(text: string, d: string) {
  const recs = parseDelimited(text, d, SCAN_RECORDS);
  const counts = new Map<number, number>();
  for (const r of recs) counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
  let modal = 0;
  let best = 0;
  for (const [len, k] of counts)
    if (k > best || (k === best && len > modal)) {
      best = k;
      modal = len;
    }
  return { records: recs.length, width: modal, consistency: recs.length ? best / recs.length : 0 };
}

function pickDelimited(text: string): "tsv" | "csv" | "semicolon" | "pipe" {
  const tab = score(text, "\t");
  if (tab.width >= 2 && tab.consistency >= MIN_CONSISTENCY) return "tsv";
  let best: "csv" | "semicolon" | "pipe" | null = null;
  let bs = { consistency: 0, width: 0 };
  for (const f of ["csv", "semicolon", "pipe"] as const) {
    const s = score(text, DELIMS[f]);
    if (s.records < 2 || s.width < 2 || s.consistency < MIN_CONSISTENCY) continue;
    if (
      s.consistency > bs.consistency ||
      (s.consistency === bs.consistency && s.width > bs.width)
    ) {
      best = f;
      bs = s;
    }
  }
  return best ?? "tsv";
}

function delimited(text: string, f: "tsv" | "csv" | "semicolon" | "pipe", columns?: string[]) {
  const table = parseDelimited(text, DELIMS[f]);
  return {
    format: f,
    delimiter: DELIMS[f],
    hasHeader: looksLikeHeader(table, columns),
    table,
  } satisfies Detected;
}

/** Guess the format of pasted text and parse it. */
export function detect(text: string, columns?: string[]): Detected {
  const s = stripBom(text);
  const json = jsonTable(s);
  if (json)
    return {
      format: "json",
      delimiter: "",
      hasHeader: json.header || looksLikeHeader(json.table, columns),
      table: json.table,
    };
  const md = markdownTable(s, true);
  if (md) return { format: "markdown", delimiter: "|", hasHeader: true, table: md.table };
  return delimited(s, pickDelimited(s), columns);
}

/** Re-parse with a chosen format. */
export function interpretAs(text: string, format: InterpretFormat, columns?: string[]): Detected {
  const s = stripBom(text);
  switch (format) {
    case "json": {
      const j = jsonTable(s);
      if (!j)
        return { format, delimiter: "", hasHeader: false, table: [], error: "Not a JSON array" };
      return {
        format,
        delimiter: "",
        hasHeader: j.header || looksLikeHeader(j.table, columns),
        table: j.table,
      };
    }
    case "markdown": {
      const m = markdownTable(s, false)!;
      return { format, delimiter: "|", hasHeader: m.header, table: m.table };
    }
    case "single":
      return {
        format,
        delimiter: "",
        hasHeader: false,
        table: [[s.replace(/\r\n$|\n$|\r$/, "")]],
      };
    default:
      return delimited(s, format, columns);
  }
}
