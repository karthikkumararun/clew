import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { lookOf } from "../grid/cellStyle";

export type Parsed = { ok: true; value: Value } | { ok: false; error: string };

/** Kinds the editor won't touch (the user can still Set NULL). */
export const READ_ONLY_KINDS = new Set(["bytes"]);

/** The text an editor starts with for a value. */
export function editText(v: Value): string {
  switch (v.kind) {
    case "null":
      return "";
    case "json":
      return JSON.stringify(v.value, null, 2);
    case "text":
      return v.value;
    case "other":
      return v.type_name === "default" ? "" : v.value;
    default:
      return lookOf(v).text;
  }
}

const INT = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;

/** Turn what was typed into a value of the column's kind. */
export function parseEdit(col: Pick<ColumnMeta, "kind">, raw: string): Parsed {
  const text = raw.trim();
  switch (col.kind) {
    case "int":
    case "bigint": {
      if (!INT.test(text)) return { ok: false, error: "Enter a whole number" };
      const n = Number(text);
      return Number.isSafeInteger(n)
        ? { ok: true, value: { kind: "int", value: n } }
        : { ok: true, value: { kind: "bigint", value: text.replace(/^\+/, "") } };
    }
    case "float": {
      const n = Number(text);
      return text !== "" && Number.isFinite(n)
        ? { ok: true, value: { kind: "float", value: n } }
        : { ok: false, error: "Enter a number" };
    }
    case "decimal":
      return DECIMAL.test(text)
        ? { ok: true, value: { kind: "decimal", value: text.replace(/^\+/, "") } }
        : { ok: false, error: "Enter a number" };
    case "bool": {
      const t = text.toLowerCase();
      if (["true", "t", "1", "yes", "y"].includes(t))
        return { ok: true, value: { kind: "bool", value: true } };
      if (["false", "f", "0", "no", "n"].includes(t))
        return { ok: true, value: { kind: "bool", value: false } };
      return { ok: false, error: "Enter true or false" };
    }
    case "json":
      try {
        return { ok: true, value: { kind: "json", value: JSON.parse(raw) } };
      } catch (e) {
        return { ok: false, error: `Not valid JSON: ${(e as Error).message}` };
      }
    case "date":
    case "time":
    case "timestamp":
    case "timestamptz":
    case "uuid":
      return text
        ? { ok: true, value: { kind: col.kind, value: text } }
        : { ok: false, error: "Enter a value" };
    default:
      return { ok: true, value: { kind: "text", value: raw } };
  }
}

/** A hint for what a column of this kind takes. */
export function placeholderFor(kind: ColumnMeta["kind"]): string | undefined {
  switch (kind) {
    case "date":
      return "YYYY-MM-DD";
    case "time":
      return "HH:MM:SS";
    case "timestamp":
      return "YYYY-MM-DD HH:MM:SS";
    case "timestamptz":
      return "YYYY-MM-DD HH:MM:SS+00";
    case "uuid":
      return "00000000-0000-0000-0000-000000000000";
    default:
      return undefined;
  }
}
