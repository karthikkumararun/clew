/**
 * Contract: exact decimal arithmetic for the grid tools. A decimal is a BigInt `int` and a
 * `scale` (digits after the point), so 1150.00 is { int: 115000n, scale: 2 }. No function here
 * touches floating point. Pure, framework-free and worker-safe.
 */

import type { Value } from "../../../lib/ipc/drivers";

export interface Decimal {
  int: bigint;
  scale: number;
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/;
const MAX_EXPONENT = 1000;

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Parse plain or scientific decimal text; `null` when it is not a finite decimal number. */
export function parseDecimal(text: string): Decimal | null {
  const m = DECIMAL.exec(text.trim());
  if (!m) return null;
  const [, sign, whole, frac = "", exp = "0"] = m;
  if (whole === "" && frac === "") return null;
  const e = Number(exp);
  if (Math.abs(e) > MAX_EXPONENT) return null;
  let int = BigInt(`${whole || "0"}${frac}`);
  let scale = frac.length - e;
  if (scale < 0) {
    int *= pow10(-scale);
    scale = 0;
  }
  return { int: sign === "-" ? -int : int, scale };
}

/** The same number written with `scale` fraction digits (must be >= the current scale). */
export function rescale(d: Decimal, scale: number): Decimal {
  if (scale === d.scale) return d;
  if (scale < d.scale) throw new Error("rescale cannot drop digits");
  return { int: d.int * pow10(scale - d.scale), scale };
}

export function compareDecimal(a: Decimal, b: Decimal): number {
  const s = Math.max(a.scale, b.scale);
  const x = rescale(a, s).int;
  const y = rescale(b, s).int;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Plain text with exactly `d.scale` fraction digits: `{ 115000n, 2 }` becomes "1150.00". */
export function decimalToString(d: Decimal): string {
  const neg = d.int < 0n;
  const digits = (neg ? -d.int : d.int).toString().padStart(d.scale + 1, "0");
  const whole = digits.slice(0, digits.length - d.scale);
  const frac = digits.slice(digits.length - d.scale);
  return `${neg ? "-" : ""}${whole}${d.scale > 0 ? `.${frac}` : ""}`;
}

/** Divide by a positive count, rounding half away from zero to `scale` fraction digits. */
export function divideRound(d: Decimal, divisor: bigint, scale: number): Decimal {
  // One extra digit is computed, then rounded half away from zero.
  const q = (d.int * pow10(scale + 1)) / (pow10(d.scale) * divisor);
  const neg = q < 0n;
  const rounded = ((neg ? -q : q) + 5n) / 10n;
  return { int: neg ? -rounded : rounded, scale };
}

/** Drop trailing fraction zeros but never go below `minScale` digits. */
export function trimScale(d: Decimal, minScale: number): Decimal {
  let { int, scale } = d;
  while (scale > minScale && int % 10n === 0n) {
    int /= 10n;
    scale--;
  }
  return { int, scale };
}

/** "1450.00" to "1,450.00" (thousands grouping of the integer part). */
export function groupDecimalText(text: string, sep = ","): string {
  const m = /^(-?)(\d+)(.*)$/.exec(text);
  if (!m) return text;
  return `${m[1]}${m[2].replace(/\B(?=(\d{3})+(?!\d))/g, sep)}${m[3]}`;
}

/** The scale a column type declares: `numeric(10,2)` gives 2, `NUMBER(8)` gives 0, else null. */
export function scaleFromTypeName(typeName: string): number | null {
  const m = /\(\s*\d+\s*(?:,\s*(-?\d+)\s*)?\)/.exec(typeName);
  if (!m) return null;
  const s = m[1] === undefined ? 0 : Number(m[1]);
  return s >= 0 ? s : 0;
}

export type Numeric = { exact: Decimal } | { float: number };

/** The numeric reading of a cell: exact for int, bigint and decimal; a double for float. */
export function numericOf(v: Value): Numeric | null {
  switch (v.kind) {
    case "int":
      return Number.isFinite(v.value)
        ? { exact: { int: BigInt(Math.trunc(v.value)), scale: 0 } }
        : null;
    case "bigint":
    case "decimal": {
      const d = parseDecimal(v.value);
      return d ? { exact: d } : null;
    }
    case "float":
      return Number.isFinite(v.value) ? { float: v.value } : null;
    default:
      return null;
  }
}

/** Compare two numerics; exact against exact stays exact. */
export function compareNumeric(a: Numeric, b: Numeric): number {
  if ("exact" in a && "exact" in b) return compareDecimal(a.exact, b.exact);
  const x = "exact" in a ? Number(decimalToString(a.exact)) : a.float;
  const y = "exact" in b ? Number(decimalToString(b.exact)) : b.float;
  return x < y ? -1 : x > y ? 1 : 0;
}
