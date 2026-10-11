import type { KeyInfo } from "./api";

/** Double-quote a value the way the console's tokenizer reads it back. */
export function quote(value: string): string {
  let out = '"';
  for (const ch of value) {
    switch (ch) {
      case "\\":
        out += "\\\\";
        break;
      case '"':
        out += '\\"';
        break;
      case "\n":
        out += "\\n";
        break;
      case "\r":
        out += "\\r";
        break;
      case "\t":
        out += "\\t";
        break;
      default:
        out += ch.charCodeAt(0) < 32 ? `\\x${ch.charCodeAt(0).toString(16).padStart(2, "0")}` : ch;
    }
  }
  return `${out}"`;
}

/** A command line from a name and its arguments, each quoted. */
export const line = (...args: string[]) => args.map((a, i) => (i === 0 ? a : quote(a))).join(" ");

export interface KeyGroup {
  /** `session:*` */
  label: string;
  prefix: string;
  keys: KeyInfo[];
}

export interface Grouped {
  groups: KeyGroup[];
  /** Keys with no `:` in their name. */
  plain: KeyInfo[];
}

/** Group keys by the part before the first `:`. */
export function groupKeys(keys: KeyInfo[]): Grouped {
  const byPrefix = new Map<string, KeyInfo[]>();
  const plain: KeyInfo[] = [];
  for (const k of keys) {
    const i = k.name.indexOf(":");
    if (i <= 0) {
      plain.push(k);
      continue;
    }
    const prefix = k.name.slice(0, i + 1);
    const list = byPrefix.get(prefix) ?? [];
    list.push(k);
    byPrefix.set(prefix, list);
  }
  const byName = (a: KeyInfo, b: KeyInfo) => a.name.localeCompare(b.name);
  const groups = [...byPrefix.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, list]) => ({ label: `${prefix}*`, prefix, keys: list.sort(byName) }));
  return { groups, plain: plain.sort(byName) };
}

/** `5m 3s`, `2d 4h`, `no expiry`. */
export function formatTtl(ms: number | null): string {
  if (ms === null) return "no expiry";
  if (ms < 1000) return `${ms} ms`;
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const parts: [number, string][] = [
    [d, "d"],
    [h, "h"],
    [m, "m"],
    [s, "s"],
  ];
  return parts
    .filter(([n]) => n > 0)
    .slice(0, 2)
    .map(([n, u]) => `${n}${u}`)
    .join(" ");
}

/** `1.2 KB` style sizes. */
export function formatBytes(n: number): string {
  if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

/** Try to read `text` as JSON and pretty-print it. */
export function prettyJson(text: string): string | null {
  const t = text.trim();
  if (!t || !/^[{["\d-]|^(true|false|null)$/.test(t)) return null;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return null;
  }
}

/** Hex dump, 16 bytes per line, for binary values and the string viewer's hex mode. */
export function hexDump(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const lines: string[] = [];
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16);
    const hex = Array.from(chunk, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(chunk, (b) =>
      b >= 32 && b < 127 ? String.fromCharCode(b) : ".",
    ).join("");
    lines.push(`${i.toString(16).padStart(8, "0")}  ${hex.padEnd(47, " ")}  ${ascii}`);
  }
  return lines.join("\n");
}

/** Hex string (as the server sends binary) to a dump. */
export function hexStringDump(hex: string): string {
  const lines: string[] = [];
  for (let i = 0; i < hex.length; i += 32) {
    const chunk = hex.slice(i, i + 32).match(/../g) ?? [];
    const ascii = chunk
      .map((h) => {
        const b = parseInt(h, 16);
        return b >= 32 && b < 127 ? String.fromCharCode(b) : ".";
      })
      .join("");
    lines.push(
      `${(i / 2).toString(16).padStart(8, "0")}  ${chunk.join(" ").padEnd(47, " ")}  ${ascii}`,
    );
  }
  return lines.join("\n");
}
