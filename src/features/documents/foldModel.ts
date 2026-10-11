import { childrenOf, describe, toShell } from "./ejson";
import type { EJson } from "./ejson";

export interface JsonLine {
  /** Stable id of the fold this line opens (`doc|path`), when it opens one. */
  fold: string | null;
  folded: boolean;
  depth: number;
  text: string;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const keyText = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

/**
 * A document as lines of shell-syntax JSON. Every object and array with content opens a fold;
 * `folded` holds the ids of the ones that are closed, which collapse to a single summary line.
 */
export function jsonLines(doc: EJson, docId: string, folded: ReadonlySet<string>): JsonLine[] {
  const out: JsonLine[] = [];
  const walk = (
    value: EJson,
    label: string | null,
    path: string[],
    depth: number,
    last: boolean,
  ) => {
    const d = describe(value);
    const prefix = label === null ? "" : `${label}: `;
    const comma = last ? "" : ",";
    if (!d.container) {
      out.push({ fold: null, folded: false, depth, text: `${prefix}${toShell(value)}${comma}` });
      return;
    }
    const kids = childrenOf(value);
    const array = Array.isArray(value);
    const [open, close] = array ? ["[", "]"] : ["{", "}"];
    if (kids.length === 0) {
      out.push({ fold: null, folded: false, depth, text: `${prefix}${open}${close}${comma}` });
      return;
    }
    const id = `${docId}|${JSON.stringify(path)}`;
    if (folded.has(id)) {
      out.push({
        fold: id,
        folded: true,
        depth,
        text: `${prefix}${open} … ${kids.length} ${array ? (kids.length === 1 ? "element" : "elements") : kids.length === 1 ? "field" : "fields"} ${close}${comma}`,
      });
      return;
    }
    out.push({ fold: id, folded: false, depth, text: `${prefix}${open}` });
    kids.forEach(([k, child], i) => {
      walk(child, array ? null : keyText(k), [...path, k], depth + 1, i === kids.length - 1);
    });
    out.push({ fold: null, folded: false, depth, text: `${close}${comma}` });
  };
  walk(doc, null, [], 0, true);
  return out;
}
