/**
 * Label colours. Ten colours taken from the token hues, assigned by a stable hash of the label
 * name so a label has the same colour in every session. Cytoscape draws on a canvas and cannot
 * use `var(--token)`, so `resolveToken` reads the computed value when the graph is built.
 */
export const LABEL_TOKENS = [
  "--syn-function",
  "--syn-number",
  "--syn-keyword",
  "--syn-string",
  "--syn-boolean",
  "--drv-neo4j",
  "--drv-clickhouse",
  "--drv-oracle",
  "--drv-sqlite",
  "--drv-postgres",
] as const;

export type LabelToken = (typeof LABEL_TOKENS)[number];

/** FNV-1a over the UTF-16 code units. */
export function hashLabel(label: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < label.length; i++) {
    h ^= label.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export const tokenOfLabel = (label: string): LabelToken =>
  LABEL_TOKENS[hashLabel(label) % LABEL_TOKENS.length];

/** CSS colour of a label chip. */
export const cssOfLabel = (label: string): string => `var(${tokenOfLabel(label)})`;

/** The computed value of a token (`#rrggbb`), for canvas drawing. Empty when unavailable. */
export function resolveToken(token: string): string {
  if (typeof document === "undefined") return "";
  return getComputedStyle(document.documentElement).getPropertyValue(token).trim();
}
