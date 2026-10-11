import { childrenOf, describe, idLabel } from "./ejson";
import type { Described, EJson } from "./ejson";

export interface TreeRow {
  /** Stable across reloads: the document's `_id` plus the path. */
  key: string;
  docIndex: number;
  path: string[];
  depth: number;
  label: string;
  value: EJson;
  described: Described;
  isDoc: boolean;
  expandable: boolean;
  expanded: boolean;
}

/**
 * The flat list of visible tree rows for `docs`: a row per document, and under each expanded
 * document / object / array a row per child. `expanded` holds the row keys the user opened.
 */
export function flattenDocs(
  docs: EJson[],
  expanded: ReadonlySet<string>,
  docKeyOf: (doc: EJson) => string,
): TreeRow[] {
  const rows: TreeRow[] = [];
  docs.forEach((doc, docIndex) => {
    const base = docKeyOf(doc);
    const walk = (value: EJson, path: string[], depth: number, label: string) => {
      const described = describe(value);
      const key = `${base}|${JSON.stringify(path)}`;
      const open = described.container && expanded.has(key);
      rows.push({
        key,
        docIndex,
        path,
        depth,
        label,
        value,
        described,
        isDoc: path.length === 0,
        expandable: described.container && childrenOf(value).length > 0,
        expanded: open,
      });
      if (open) {
        for (const [k, child] of childrenOf(value)) walk(child, [...path, k], depth + 1, k);
      }
    };
    walk(doc, [], 0, `(${docIndex + 1}) ${idLabel(doc)}`);
  });
  return rows;
}
