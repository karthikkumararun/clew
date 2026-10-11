/**
 * Canonical Extended JSON as the document browser sees it: a type for every value, a display
 * string, the shell-syntax text a person reads and writes, and the reverse for edits.
 */

export type EJson = null | boolean | number | string | EJson[] | { [key: string]: EJson };

export type TypeName =
  | "ObjectId"
  | "String"
  | "Int32"
  | "Int64"
  | "Double"
  | "Decimal128"
  | "Boolean"
  | "Date"
  | "Null"
  | "Document"
  | "Array"
  | "Binary"
  | "UUID"
  | "Regex"
  | "Timestamp"
  | "MinKey"
  | "MaxKey"
  | "Undefined"
  | "Code"
  | "Symbol";

/** Types a person can choose when adding or changing a scalar. */
export const EDITABLE_TYPES: TypeName[] = [
  "String",
  "Int32",
  "Int64",
  "Double",
  "Decimal128",
  "Boolean",
  "Date",
  "ObjectId",
  "Null",
];

export type TypeToken =
  "string" | "number" | "objectid" | "date" | "boolean" | "container" | "other";

/** The syntax-colour token class of a type (see `--syn-*` in tokens.css). */
export function tokenOf(type: TypeName): TypeToken {
  switch (type) {
    case "String":
    case "Symbol":
    case "Code":
      return "string";
    case "Int32":
    case "Int64":
    case "Double":
    case "Decimal128":
      return "number";
    case "ObjectId":
    case "UUID":
      return "objectid";
    case "Date":
    case "Timestamp":
      return "date";
    case "Boolean":
      return "boolean";
    case "Document":
    case "Array":
      return "container";
    default:
      return "other";
  }
}

const isObj = (v: EJson): v is { [key: string]: EJson } =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function only(v: { [key: string]: EJson }, key: string): EJson | undefined {
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === key ? v[key] : undefined;
}

export interface Described {
  type: TypeName;
  /** What the Value column shows. */
  display: string;
  /** The scalar's own text, for the edit box (without quotes or constructors). */
  text: string;
  container: boolean;
}

export function dateIso(ms: string | number): string {
  const n = Number(ms);
  if (!Number.isFinite(n)) return String(ms);
  try {
    return new Date(n).toISOString();
  } catch {
    return String(ms);
  }
}

function uuidFromBase64(b64: string): string {
  const raw = atob(b64);
  const hex = Array.from(raw, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function describe(v: EJson): Described {
  const scalar = (type: TypeName, display: string, text = display): Described => ({
    type,
    display,
    text,
    container: false,
  });
  if (v === null) return scalar("Null", "null");
  if (typeof v === "boolean") return scalar("Boolean", String(v));
  if (typeof v === "string") return scalar("String", JSON.stringify(v), v);
  if (typeof v === "number") return scalar("Double", String(v));
  if (Array.isArray(v)) {
    return {
      type: "Array",
      display: `[ ${v.length} ${v.length === 1 ? "element" : "elements"} ]`,
      text: "",
      container: true,
    };
  }
  const oid = only(v, "$oid");
  if (typeof oid === "string") return scalar("ObjectId", `ObjectId("${oid}")`, oid);
  const int = only(v, "$numberInt");
  if (typeof int === "string") return scalar("Int32", int);
  const long = only(v, "$numberLong");
  if (typeof long === "string") return scalar("Int64", long);
  const dbl = only(v, "$numberDouble");
  if (typeof dbl === "string") return scalar("Double", dbl);
  const dec = only(v, "$numberDecimal");
  if (typeof dec === "string") return scalar("Decimal128", `NumberDecimal("${dec}")`, dec);
  const date = only(v, "$date");
  if (date !== undefined) {
    const ms = isObj(date as EJson) ? (date as { $numberLong?: string }).$numberLong : date;
    const iso = dateIso(ms as string | number);
    return scalar("Date", iso);
  }
  const bin = only(v, "$binary");
  if (isObj(bin as EJson)) {
    const b = bin as { base64?: string; subType?: string };
    if (b.subType === "04" && typeof b.base64 === "string") {
      try {
        const u = uuidFromBase64(b.base64);
        return scalar("UUID", `UUID("${u}")`, u);
      } catch {
        /* fall through to plain binary */
      }
    }
    const bytes = Math.floor(((b.base64?.length ?? 0) * 3) / 4);
    return scalar("Binary", `BinData(${parseInt(b.subType ?? "0", 16)}, ${bytes} bytes)`);
  }
  const re = only(v, "$regularExpression");
  if (isObj(re as EJson)) {
    const r = re as { pattern?: string; options?: string };
    return scalar("Regex", `/${r.pattern ?? ""}/${r.options ?? ""}`);
  }
  const ts = only(v, "$timestamp");
  if (isObj(ts as EJson)) {
    const t = ts as { t?: number; i?: number };
    return scalar("Timestamp", `Timestamp(${t.t ?? 0}, ${t.i ?? 0})`);
  }
  if (only(v, "$minKey") !== undefined) return scalar("MinKey", "MinKey");
  if (only(v, "$maxKey") !== undefined) return scalar("MaxKey", "MaxKey");
  if (only(v, "$undefined") !== undefined) return scalar("Undefined", "undefined");
  const sym = only(v, "$symbol");
  if (typeof sym === "string") return scalar("Symbol", JSON.stringify(sym), sym);
  const code = only(v, "$code");
  if (typeof code === "string") return scalar("Code", code);
  const n = Object.keys(v).length;
  return {
    type: "Document",
    display: `{ ${n} ${n === 1 ? "field" : "fields"} }`,
    text: "",
    container: true,
  };
}

export function childrenOf(v: EJson): [string, EJson][] {
  if (Array.isArray(v)) return v.map((x, i) => [String(i), x]);
  if (isObj(v) && describe(v).container) return Object.entries(v);
  return [];
}

// ---- shell syntax --------------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function keyText(k: string): string {
  return IDENT.test(k) ? k : JSON.stringify(k);
}

/** A value in the shell's syntax: `ObjectId("…")`, `ISODate("…")`, `NumberLong("5")`… */
export function toShell(v: EJson, indent = 2, level = 0): string {
  const d = describe(v);
  if (!d.container) {
    switch (d.type) {
      case "Date":
        return `ISODate("${d.display}")`;
      case "Int64":
        return `NumberLong("${d.display}")`;
      case "Int32":
      case "Double":
        return d.display;
      case "Binary":
      case "Code":
      case "Symbol":
        return d.type === "Symbol" ? d.display : JSON.stringify(v);
      default:
        return d.display;
    }
  }
  const pad = " ".repeat(indent * (level + 1));
  const close = " ".repeat(indent * level);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return `[\n${v.map((x) => pad + toShell(x, indent, level + 1)).join(",\n")}\n${close}]`;
  }
  const entries = Object.entries(v as { [k: string]: EJson });
  if (entries.length === 0) return "{}";
  return `{\n${entries
    .map(([k, x]) => `${pad}${keyText(k)}: ${toShell(x, indent, level + 1)}`)
    .join(",\n")}\n${close}}`;
}

/** One line, for the collapsed row summary: `{ sku: "TBL-OAK", qty: 1 }`. */
export function summary(v: EJson, max = 80): string {
  const d = describe(v);
  if (!d.container) return d.display;
  const parts = childrenOf(v).map(([k, x]) => {
    const xd = describe(x);
    const text = xd.container ? (Array.isArray(x) ? "[…]" : "{…}") : xd.display;
    return Array.isArray(v) ? text : `${keyText(k)}: ${text}`;
  });
  const open = Array.isArray(v) ? "[" : "{";
  const close = Array.isArray(v) ? "]" : "}";
  const s = `${open} ${parts.join(", ")} ${close}`;
  return s.length > max ? `${s.slice(0, max - 2)}… ${close}` : s;
}

// ---- edits -----------------------------------------------------------------------------------------

export type ParsedEdit = { ok: true; value: EJson } | { ok: false; error: string };

/** Build the Extended JSON of a scalar a person typed, for the chosen type. */
export function parseScalar(type: TypeName, text: string): ParsedEdit {
  const t = text.trim();
  switch (type) {
    case "String":
      return { ok: true, value: text };
    case "Null":
      return { ok: true, value: null };
    case "Boolean":
      if (t === "true" || t === "false") return { ok: true, value: t === "true" };
      return { ok: false, error: "Type true or false" };
    case "Int32":
      if (/^-?\d+$/.test(t) && Number(t) >= -2147483648 && Number(t) <= 2147483647) {
        return { ok: true, value: { $numberInt: String(Number(t)) } };
      }
      return { ok: false, error: "Not a 32-bit integer" };
    case "Int64":
      if (/^-?\d+$/.test(t) && BigInt(t) >= -(2n ** 63n) && BigInt(t) < 2n ** 63n) {
        return { ok: true, value: { $numberLong: BigInt(t).toString() } };
      }
      return { ok: false, error: "Not a 64-bit integer" };
    case "Double": {
      if (t === "") return { ok: false, error: "Not a number" };
      const n = Number(t);
      if (Number.isNaN(n) && t !== "NaN") return { ok: false, error: "Not a number" };
      const s = Number.isInteger(n) && !/[.eE]/.test(t) ? `${n}.0` : String(n);
      return {
        ok: true,
        value: {
          $numberDouble: Number.isNaN(n)
            ? "NaN"
            : n === Infinity
              ? "Infinity"
              : n === -Infinity
                ? "-Infinity"
                : s,
        },
      };
    }
    case "Decimal128":
      if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(t))
        return { ok: true, value: { $numberDecimal: t } };
      return { ok: false, error: "Not a decimal number" };
    case "Date": {
      const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(t) ? `${t}T00:00:00Z` : t);
      if (Number.isNaN(ms)) return { ok: false, error: "Use an ISO 8601 date, e.g. 2026-10-01" };
      return { ok: true, value: { $date: { $numberLong: String(ms) } } };
    }
    case "ObjectId":
      if (/^[0-9a-fA-F]{24}$/.test(t)) return { ok: true, value: { $oid: t.toLowerCase() } };
      return { ok: false, error: "An ObjectId is 24 hexadecimal characters" };
    default:
      return { ok: false, error: `${type} values can't be edited here` };
  }
}

/** Text to start the edit box with. */
export function editText(v: EJson): string {
  const d = describe(v);
  return d.type === "Date" ? d.display : d.text;
}

/** Keys the dotted `$set` path syntax can't express. */
export function dottable(path: string[]): boolean {
  return path.every((p) => p !== "" && !p.includes(".") && !p.startsWith("$"));
}

export function getAt(root: EJson, path: string[]): EJson | undefined {
  let cur: EJson | undefined = root;
  for (const p of path) {
    if (Array.isArray(cur)) cur = cur[Number(p)];
    else if (
      isObj(cur as EJson) &&
      cur !== undefined &&
      Object.prototype.hasOwnProperty.call(cur, p)
    )
      cur = (cur as { [k: string]: EJson })[p];
    else return undefined;
  }
  return cur;
}

/** A copy of `root` with the value at `path` replaced (or removed when `value` is undefined). */
export function setAt(root: EJson, path: string[], value: EJson | undefined): EJson {
  if (path.length === 0) return value === undefined ? root : value;
  const [head, ...rest] = path;
  if (Array.isArray(root)) {
    const copy = root.slice();
    const i = Number(head);
    if (rest.length === 0 && value === undefined) copy.splice(i, 1);
    else copy[i] = setAt(copy[i] ?? null, rest, value);
    return copy;
  }
  const obj = { ...(isObj(root) ? root : {}) };
  if (rest.length === 0 && value === undefined) delete obj[head];
  else obj[head] = setAt(obj[head] ?? null, rest, value);
  return obj;
}

/** `_id` of a document, as sent back to the server. */
export function idOf(doc: EJson): EJson | undefined {
  return isObj(doc) ? doc._id : undefined;
}

/** A short label for a document row: `_id` shown the way the canvas does. */
export function idLabel(doc: EJson, max = 28): string {
  const id = idOf(doc);
  if (id === undefined) return "(no _id)";
  const d = describe(id);
  const s = d.display;
  return s.length > max
    ? `${s.slice(0, Math.floor(max / 2))}…${s.slice(-Math.floor(max / 2) + 3)}`
    : s;
}
