import type { Value } from "../../lib/ipc/drivers";
import { valueText } from "../console/valueFormat";

/** How one value is drawn. Colour names are design tokens, resolved by the theme. */
export interface CellLook {
  /** What the cell shows. */
  text: string;
  /** What Mod+C copies (NULL copies as an empty field). */
  copy: string;
  /** Token (without `--`) for the text colour. */
  token: "text" | "syn-number" | "syn-date" | "syn-boolean" | "syn-null" | "syn-link";
  align: "left" | "right";
  italic: boolean;
  underline: boolean;
  /** The server sent only the start of a large value. */
  truncated: boolean;
  kind: Value["kind"];
}

const NUMERIC = new Set<Value["kind"]>(["int", "bigint", "float", "decimal"]);
const TEMPORAL = new Set<Value["kind"]>(["date", "time", "timestamp", "timestamptz", "interval"]);

/** A single line of text: newlines would not fit a 26px row. */
export const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ↵ ");

export function isTruncated(v: Value): boolean {
  return (v.kind === "text" || v.kind === "bytes") && v.truncated === true;
}

/** The look of a value: colour by kind, alignment, italics for NULL, a link for foreign keys. */
export function lookOf(v: Value, opts: { foreignKey?: boolean } = {}): CellLook {
  const raw = valueText(v);
  const truncated = isTruncated(v);
  const base = {
    align: NUMERIC.has(v.kind) ? ("right" as const) : ("left" as const),
    truncated,
    kind: v.kind,
  };
  if (raw === null) {
    return { ...base, text: "NULL", copy: "", token: "syn-null", italic: true, underline: false };
  }
  const text = oneLine(raw) + (truncated ? "…" : "");
  const fk = opts.foreignKey === true;
  const token = fk
    ? "syn-link"
    : NUMERIC.has(v.kind)
      ? "syn-number"
      : TEMPORAL.has(v.kind)
        ? "syn-date"
        : v.kind === "bool"
          ? "syn-boolean"
          : "text";
  return { ...base, text, copy: raw, token, italic: false, underline: fk };
}
