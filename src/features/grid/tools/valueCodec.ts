/**
 * Contract: the pure layer behind the value editor panel (spec: data-grid › Value editor panel).
 * `decode(value, display)` reads a stored value as text in a Display-as mode; `encode(text,
 * display, kind)` converts the edited text back. Display as only changes how the stored bytes or
 * number are READ, never the stored value: `editThroughDisplay` returns the original value when
 * the text is unchanged, and rejects with a reason when the text does not survive the round
 * trip (a comma that is not a thousands separator, odd-length hex, invalid UTF-8, a date that
 * does not exist, text that cannot be re-read the same way). Also: Highlight as language ids for
 * CodeMirror and the pure parts of Load file / Save to file (names, extensions, bytes). No DOM,
 * no dialog and no IPC here; the Rust and dialog parts live elsewhere.
 */
import type { Value, ValueKind } from "../../../lib/ipc/drivers";
import { valueText } from "../../console/valueFormat";
import { decimalToString, groupDecimalText, parseDecimal } from "./decimal";

export type DisplayAs =
  | "default"
  | "text"
  | "hex"
  | "base64"
  | "uuid"
  | "grouped"
  | "scientific"
  | "json-pretty"
  | "json-compact"
  | "iso8601"
  | "us"
  | "eu"
  | "epoch-s"
  | "epoch-ms";

export const DISPLAY_LABELS: Record<DisplayAs, string> = {
  default: "Default",
  text: "Text (UTF-8)",
  hex: "Hex",
  base64: "Base64",
  uuid: "UUID",
  grouped: "Grouped (1,234.5)",
  scientific: "Scientific",
  "json-pretty": "JSON (pretty)",
  "json-compact": "JSON (compact)",
  iso8601: "ISO 8601",
  us: "MM/DD/YYYY",
  eu: "DD.MM.YYYY",
  "epoch-s": "Unix seconds",
  "epoch-ms": "Unix milliseconds",
};

/** The Display as choices for a column kind; the first is the default. */
export function displayModesFor(kind: ValueKind): DisplayAs[] {
  switch (kind) {
    case "bytes":
      return ["hex", "text", "base64", "uuid"];
    case "int":
    case "bigint":
    case "decimal":
      return ["default", "grouped"];
    case "float":
      return ["default", "grouped", "scientific"];
    case "json":
      return ["json-pretty", "json-compact"];
    case "text":
      return ["default", "json-pretty", "json-compact"];
    case "date":
      return ["default", "iso8601", "us", "eu"];
    case "timestamp":
    case "timestamptz":
      return ["default", "iso8601", "us", "eu", "epoch-s", "epoch-ms"];
    default:
      return ["default"];
  }
}

export const defaultDisplay = (kind: ValueKind): DisplayAs => displayModesFor(kind)[0];

export type Decoded =
  { ok: true; text: string; truncated?: boolean } | { ok: false; reason: string };
export type Encoded = { ok: true; value: Value } | { ok: false; reason: string };

const fail = (reason: string): { ok: false; reason: string } => ({ ok: false, reason });

// ---- bytes helpers ---------------------------------------------------------------------------

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

const bytesValue = (bytes: Uint8Array): Value => ({
  kind: "bytes",
  value: bytesToHex(bytes),
  len: bytes.length,
});

// ---- dates -----------------------------------------------------------------------------------

interface Parts {
  y: number;
  mo: number;
  d: number;
  hasTime: boolean;
  h: number;
  mi: number;
  s: number;
  /** ".123" or "". */
  frac: string;
  /** "+02:00" or null. */
  tz: string | null;
}

const TZ = "(Z|[+-]\\d{2}(?::?\\d{2})?)";
const TIME = `(?:[ T]?(\\d{2}):(\\d{2})(?::(\\d{2})(\\.\\d+)?)?)?\\s*${TZ}?`;
const TS = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})${TIME}$`);
const US = new RegExp(`^(\\d{1,2})/(\\d{1,2})/(\\d{4})${TIME}$`);
const EU = new RegExp(`^(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${TIME}$`);

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function normTz(tz: string | undefined): string | null {
  if (!tz) return null;
  if (tz === "Z") return "+00:00";
  const m = /^([+-])(\d{2}):?(\d{2})?$/.exec(tz);
  return m ? `${m[1]}${m[2]}:${m[3] ?? "00"}` : null;
}

function validParts(p: Parts): string | null {
  const t = new Date(Date.UTC(p.y, p.mo - 1, p.d));
  if (t.getUTCFullYear() !== p.y || t.getUTCMonth() !== p.mo - 1 || t.getUTCDate() !== p.d) {
    return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)} is not a real date`;
  }
  if (p.hasTime && (p.h > 23 || p.mi > 59 || p.s > 59)) return "the time is out of range";
  return null;
}

/** Parse a date or timestamp in a style; `null` when it does not match. */
function parseStyled(text: string, style: "iso" | "us" | "eu"): Parts | null {
  const m = (style === "iso" ? TS : style === "us" ? US : EU).exec(text.trim());
  if (!m) return null;
  const [y, mo, d] =
    style === "iso" ? [m[1], m[2], m[3]] : style === "us" ? [m[3], m[1], m[2]] : [m[3], m[2], m[1]];
  return {
    y: Number(y),
    mo: Number(mo),
    d: Number(d),
    hasTime: m[4] !== undefined,
    h: Number(m[4] ?? 0),
    mi: Number(m[5] ?? 0),
    s: Number(m[6] ?? 0),
    frac: m[7] ?? "",
    tz: normTz(m[8]),
  };
}

const canonical = (p: Parts): string =>
  `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}` +
  (p.hasTime ? ` ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.frac}${p.tz ?? ""}` : "");

function styled(p: Parts, style: DisplayAs): string {
  const time = p.hasTime ? `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.frac}` : "";
  const tz = p.tz ?? "";
  switch (style) {
    case "iso8601":
      return `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}${time ? `T${time}${tz}` : ""}`;
    case "us":
      return `${pad(p.mo)}/${pad(p.d)}/${pad(p.y, 4)}${time ? ` ${time}${tz ? ` ${tz}` : ""}` : ""}`;
    default:
      return `${pad(p.d)}.${pad(p.mo)}.${pad(p.y, 4)}${time ? ` ${time}${tz ? ` ${tz}` : ""}` : ""}`;
  }
}

const tzMs = (tz: string | null): number => {
  if (!tz) return 0;
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz) as RegExpExecArray;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000;
};

function epochOf(p: Parts): number {
  const ms = p.frac ? Math.round(Number(`0${p.frac}`) * 1000) : 0;
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s, ms) - tzMs(p.tz);
}

function decodeDate(raw: string, display: DisplayAs): Decoded {
  if (display === "default") return { ok: true, text: raw };
  const p = parseStyled(raw, "iso");
  if (!p) return fail(`'${raw}' is not an ISO date`);
  if (display === "epoch-s" || display === "epoch-ms") {
    const fracMs = p.frac.length > 4;
    if (fracMs) return fail("finer than a millisecond; Unix time would lose digits");
    const ms = epochOf(p);
    if (display === "epoch-ms") return { ok: true, text: String(ms) };
    if (ms % 1000 !== 0) return fail("has fractional seconds; choose Unix milliseconds");
    return { ok: true, text: String(ms / 1000) };
  }
  return { ok: true, text: styled(p, display) };
}

function encodeDate(text: string, display: DisplayAs, kind: ValueKind): Encoded {
  const t = text.trim();
  if (!t) return fail("A date is required");
  const wrap = (s: string): Encoded => ({
    ok: true,
    value: { kind: kind as "date" | "timestamp" | "timestamptz", value: s },
  });
  if (display === "default") return wrap(t);
  let p: Parts | null;
  if (display === "epoch-s" || display === "epoch-ms") {
    if (!/^-?\d+$/.test(t))
      return fail(
        `'${t}' is not a whole number of ${display === "epoch-s" ? "seconds" : "milliseconds"}`,
      );
    const ms = Number(t) * (display === "epoch-s" ? 1000 : 1);
    const dt = new Date(ms);
    if (Number.isNaN(dt.getTime())) return fail(`'${t}' is outside the date range`);
    const msPart = dt.getUTCMilliseconds();
    p = {
      y: dt.getUTCFullYear(),
      mo: dt.getUTCMonth() + 1,
      d: dt.getUTCDate(),
      hasTime: true,
      h: dt.getUTCHours(),
      mi: dt.getUTCMinutes(),
      s: dt.getUTCSeconds(),
      frac: msPart ? `.${pad(msPart, 3).replace(/0+$/, "")}` : "",
      tz: kind === "timestamptz" ? "+00:00" : null,
    };
  } else {
    p = parseStyled(t, display === "us" ? "us" : display === "eu" ? "eu" : "iso");
    if (!p) {
      const shape =
        display === "us" ? "MM/DD/YYYY" : display === "eu" ? "DD.MM.YYYY" : "YYYY-MM-DD";
      return fail(`'${t}' does not match ${shape} [HH:MM:SS]`);
    }
  }
  const bad = validParts(p);
  if (bad) return fail(bad);
  if (kind === "date" && p.hasTime) return fail("a date has no time part");
  if (kind !== "date" && !p.hasTime) p = { ...p, hasTime: true };
  if (kind === "timestamp" && p.tz)
    return fail("a timestamp without time zone cannot carry an offset");
  return wrap(canonical(p));
}

// ---- numbers ---------------------------------------------------------------------------------

const GROUPED = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/;

function decodeNumber(
  v: Value & { kind: "int" | "bigint" | "decimal" | "float" },
  display: DisplayAs,
): Decoded {
  const raw = valueText(v) ?? "";
  if (display === "default") return { ok: true, text: raw };
  if (display === "scientific") {
    return v.kind === "float"
      ? { ok: true, text: v.value.toExponential() }
      : fail("Scientific applies to floating point only");
  }
  // grouped
  const d = parseDecimal(raw);
  return { ok: true, text: d ? groupDecimalText(decimalToString(d)) : raw };
}

function encodeNumber(text: string, display: DisplayAs, kind: ValueKind): Encoded {
  let t = text.trim();
  if (!t) return fail("A number is required");
  if (t.includes(",")) {
    if (display !== "grouped" || !GROUPED.test(t)) {
      return fail(`'${t}' is ambiguous: a comma must separate thousands, as in 1,234.5`);
    }
    t = t.replace(/,/g, "");
  }
  const d = parseDecimal(t);
  if (!d) return fail(`'${t}' is not a number`);
  switch (kind) {
    case "int": {
      if (d.int % 10n ** BigInt(d.scale) !== 0n) return fail(`'${t}' is not a whole number`);
      const n = Number(decimalToString({ int: d.int / 10n ** BigInt(d.scale), scale: 0 }));
      return Number.isSafeInteger(n)
        ? { ok: true, value: { kind: "int", value: n } }
        : fail("outside the safe integer range");
    }
    case "bigint": {
      if (d.int % 10n ** BigInt(d.scale) !== 0n) return fail(`'${t}' is not a whole number`);
      return {
        ok: true,
        value: { kind: "bigint", value: (d.int / 10n ** BigInt(d.scale)).toString() },
      };
    }
    case "decimal":
      return { ok: true, value: { kind: "decimal", value: decimalToString(d) } };
    default: {
      const f = Number(t);
      return Number.isFinite(f)
        ? { ok: true, value: { kind: "float", value: f } }
        : fail(`'${t}' is not a finite number`);
    }
  }
}

// ---- json ------------------------------------------------------------------------------------

const prettyOf = (display: DisplayAs, parsed: unknown) =>
  display === "json-compact" ? JSON.stringify(parsed) : JSON.stringify(parsed, null, 2);

// ---- decode / encode -------------------------------------------------------------------------

/** The stored value read as text in a Display-as mode. */
export function decode(value: Value, display: DisplayAs): Decoded {
  switch (value.kind) {
    case "null":
      return { ok: true, text: "" };
    case "bytes": {
      const truncated = value.truncated ? { truncated: true } : {};
      const bytes = hexToBytes(value.value);
      switch (display) {
        case "text":
          try {
            return { ok: true, text: utf8.decode(bytes), ...truncated };
          } catch {
            return fail("The bytes are not valid UTF-8 text");
          }
        case "base64":
          return { ok: true, text: bytesToBase64(bytes), ...truncated };
        case "uuid": {
          if (bytes.length !== 16) return fail(`A UUID is 16 bytes; this value has ${value.len}`);
          const h = value.value;
          return {
            ok: true,
            text: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`,
            ...truncated,
          };
        }
        default:
          return { ok: true, text: value.value, ...truncated };
      }
    }
    case "int":
    case "bigint":
    case "decimal":
    case "float":
      return decodeNumber(value, display);
    case "json":
      return {
        ok: true,
        text: prettyOf(display === "default" ? "json-pretty" : display, value.value),
      };
    case "text": {
      const truncated = value.truncated ? { truncated: true } : {};
      if (display !== "json-pretty" && display !== "json-compact")
        return { ok: true, text: value.value, ...truncated };
      try {
        return { ok: true, text: prettyOf(display, JSON.parse(value.value)), ...truncated };
      } catch {
        return fail("The text is not valid JSON");
      }
    }
    case "date":
    case "timestamp":
    case "timestamptz":
      return decodeDate(value.value, display);
    default:
      return { ok: true, text: valueText(value) ?? "" };
  }
}

/** Edited text back to a value of `kind`. Does not check the round trip (see `editThroughDisplay`). */
export function encode(text: string, display: DisplayAs, kind: ValueKind): Encoded {
  switch (kind) {
    case "bytes": {
      if (display === "text")
        return { ok: true, value: bytesValue(new TextEncoder().encode(text)) };
      if (display === "base64") {
        const b = text.replace(/\s+/g, "");
        if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b) || b.length % 4 !== 0)
          return fail("Not valid Base64 (length must be a multiple of 4)");
        return { ok: true, value: bytesValue(base64ToBytes(b)) };
      }
      if (display === "uuid") {
        const h = text
          .trim()
          .replace(/^\{|\}$/g, "")
          .replace(/-/g, "");
        if (!/^[0-9a-fA-F]{32}$/.test(h))
          return fail("Not a UUID (32 hex digits, hyphens optional)");
        return { ok: true, value: bytesValue(hexToBytes(h.toLowerCase())) };
      }
      const h = text.replace(/\s+/g, "").replace(/^0x/i, "");
      if (!/^[0-9a-fA-F]*$/.test(h)) return fail("Not valid hex (0-9, a-f only)");
      if (h.length % 2 !== 0) return fail("Hex needs an even number of digits");
      return { ok: true, value: bytesValue(hexToBytes(h.toLowerCase())) };
    }
    case "int":
    case "bigint":
    case "decimal":
    case "float":
      if (display === "scientific" && kind !== "float")
        return fail("Scientific applies to floating point only");
      return encodeNumber(text, display, kind);
    case "json":
    case "text": {
      if (kind === "text" && display !== "json-pretty" && display !== "json-compact") {
        return { ok: true, value: { kind: "text", value: text } };
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (kind === "json") return { ok: true, value: { kind: "json", value: parsed as never } };
        return { ok: true, value: { kind: "text", value: prettyOf(display, parsed) } };
      } catch (e) {
        return fail(`Not valid JSON: ${e instanceof Error ? e.message : "parse error"}`);
      }
    }
    case "date":
    case "timestamp":
    case "timestamptz":
      return encodeDate(text, display, kind);
    default:
      return { ok: true, value: { kind: "text", value: text } };
  }
}

const sameValue = (a: Value, b: Value) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether reading `value` in `display` and writing it back reproduces it exactly. When it does
 * not (JSON text re-indented, a time zone spelled differently) the mode is fine to look at but
 * an edit through it would change more than the user typed.
 */
export function roundTrips(
  value: Value,
  display: DisplayAs,
): { ok: true } | { ok: false; reason: string } {
  if (value.kind === "null") return { ok: true };
  const d = decode(value, display);
  if (!d.ok) return d;
  const e = encode(d.text, display, value.kind);
  if (!e.ok) return e;
  return sameValue(e.value, value)
    ? { ok: true }
    : fail(`Saving through ${DISPLAY_LABELS[display]} would rewrite the stored value`);
}

export type EditResult =
  { ok: true; value: Value; changed: boolean } | { ok: false; reason: string };

/**
 * The edit path: unchanged text keeps the original value untouched (never a re-encode); changed
 * text is encoded and then checked to be stable (decode then encode gives the same value), which
 * rejects ambiguous round trips with a reason.
 */
export function editThroughDisplay(
  original: Value,
  text: string,
  display: DisplayAs,
  kind: ValueKind,
): EditResult {
  if (original.kind !== "null") {
    const shown = decode(original, display);
    if (shown.ok && shown.text === text) return { ok: true, value: original, changed: false };
    if (shown.ok && shown.truncated)
      return fail("The value is truncated; fetch the full value before editing");
  }
  const enc = encode(text, display, kind);
  if (!enc.ok) return enc;
  const back = decode(enc.value, display);
  if (!back.ok) return back;
  const again = encode(back.text, display, kind);
  if (!again.ok || !sameValue(again.value, enc.value)) {
    return fail("Ambiguous: this text does not read back as the same value");
  }
  return { ok: true, value: enc.value, changed: !sameValue(enc.value, original) };
}

// ---- Highlight as ----------------------------------------------------------------------------

export type HighlightAs = "plain" | "json" | "xml" | "sql";

export interface HighlightLanguage {
  id: HighlightAs;
  label: string;
  /** The CodeMirror language package, or null for no highlighting (plain). */
  cmPackage: "@codemirror/lang-json" | "@codemirror/lang-xml" | "@codemirror/lang-sql" | null;
}

export const HIGHLIGHT_LANGUAGES: readonly HighlightLanguage[] = [
  { id: "plain", label: "Plain", cmPackage: null },
  { id: "json", label: "JSON", cmPackage: "@codemirror/lang-json" },
  { id: "xml", label: "XML", cmPackage: "@codemirror/lang-xml" },
  { id: "sql", label: "SQL", cmPackage: "@codemirror/lang-sql" },
];

/** Initial Highlight as: JSON for json columns and JSON-looking text, XML for markup, else plain. */
export function defaultHighlight(kind: ValueKind, text = ""): HighlightAs {
  if (kind === "json") return "json";
  if (kind !== "text") return "plain";
  const t = text.trimStart();
  if (/^[[{]/.test(t)) {
    try {
      JSON.parse(text);
      return "json";
    } catch {
      return "plain";
    }
  }
  if (/^<(\?xml|[A-Za-z!])/.test(t)) return "xml";
  return "plain";
}

// ---- Load file / Save to file (pure parts) ---------------------------------------------------

export interface FileSuggestion {
  /** e.g. `payload.json` */
  name: string;
  extension: string;
  filters: { name: string; extensions: string[] }[];
}

const safeName = (s: string) =>
  Array.from(s, (ch) => (/[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 32 ? "_" : ch))
    .join("")
    .replace(/_+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 80) || "value";

/** File name and dialog filters for Save to file, by what is being saved and how it is shown. */
export function suggestFileName(o: {
  column: string;
  kind: ValueKind;
  display: DisplayAs;
  highlight?: HighlightAs;
}): FileSuggestion {
  let extension = "txt";
  let label = "Text";
  if (o.kind === "bytes") {
    if (o.display === "hex") [extension, label] = ["hex", "Hex"];
    else if (o.display === "base64") [extension, label] = ["b64", "Base64"];
    else if (o.display === "text") [extension, label] = ["txt", "Text"];
    else if (o.display === "uuid") [extension, label] = ["txt", "Text"];
    else [extension, label] = ["bin", "Binary"];
  } else if (
    o.kind === "json" ||
    o.highlight === "json" ||
    o.display === "json-pretty" ||
    o.display === "json-compact"
  ) {
    [extension, label] = ["json", "JSON"];
  } else if (o.highlight === "xml") {
    [extension, label] = ["xml", "XML"];
  } else if (o.highlight === "sql") {
    [extension, label] = ["sql", "SQL"];
  }
  return {
    name: `${safeName(o.column)}.${extension}`,
    extension,
    filters: [
      { name: label, extensions: [extension] },
      { name: "All files", extensions: ["*"] },
    ],
  };
}

/** A picked file's bytes as the cell value of a column kind (staged as an edit by the caller). */
export function valueFromFileBytes(bytes: Uint8Array, kind: ValueKind): Encoded {
  if (kind === "bytes") return { ok: true, value: bytesValue(bytes) };
  let text: string;
  try {
    text = utf8.decode(bytes);
  } catch {
    return fail("The file is not valid UTF-8 text; load it into a binary column");
  }
  if (kind === "text") return { ok: true, value: { kind: "text", value: text } };
  if (kind === "json") return encode(text, "json-pretty", "json");
  return fail("Load file works on text, JSON and binary cells");
}

/** The stored value as file content; `null` when there is nothing to write (NULL). */
export function valueToFileBytes(value: Value): Uint8Array | null {
  switch (value.kind) {
    case "null":
      return null;
    case "bytes":
      return hexToBytes(value.value);
    default:
      return new TextEncoder().encode(
        value.kind === "json" ? JSON.stringify(value.value, null, 2) : (valueText(value) ?? ""),
      );
  }
}

/** The grid holds a cut-off copy: fetch the full value (`value_fetch_full`) before saving. */
export function needsFullFetch(value: Value): boolean {
  return (value.kind === "text" || value.kind === "bytes") && value.truncated === true;
}

/** "2.0 MB" for the edited cell's new size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n < 10 ? 1 : 0)} ${units[i]}`;
}
