/** Small Cypher texts the graph browser writes: sidebar queries, `SET`, `MATCH` by element id. */
import type { GraphNode, GraphRel } from "./types";

/** A label, type or property name, in backticks unless it is a plain identifier. */
export function quoteName(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : `\`${name.replace(/`/g, "``")}\``;
}

/** A string literal. */
export const stringLiteral = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

/** Spec: graph-browser › Graph schema sidebar. */
export const labelQuery = (label: string) => `MATCH (n:${quoteName(label)}) RETURN n LIMIT 25`;
export const relTypeQuery = (type: string) =>
  `MATCH p=()-[:${quoteName(type)}]->() RETURN p LIMIT 25`;

export type ElementKind = "node" | "relationship";

/**
 * The parameterised update of the inspector (spec: graph-browser › Inspector). One property uses
 * `$value`; several use `$value_<key>` parameters.
 */
export function setStatement(kind: ElementKind, keys: string[]): string {
  const v = kind === "node" ? "n" : "r";
  const target = kind === "node" ? "(n)" : "()-[r]->()";
  const sets = keys
    .map((k) => `${v}.${quoteName(k)} = $${keys.length === 1 ? "value" : `value_${k}`}`)
    .join(", ");
  return `MATCH ${target} WHERE elementId(${v}) = $id SET ${sets}`;
}

/** "Copy as Cypher MATCH": the element, found by its id. */
export function matchCypher(element: GraphNode | GraphRel): string {
  if ("labels" in element) {
    const labels = element.labels.map((l) => `:${quoteName(l)}`).join("");
    return `MATCH (n${labels}) WHERE elementId(n) = ${stringLiteral(element.elementId)} RETURN n`;
  }
  return `MATCH ()-[r:${quoteName(element.relType)}]->() WHERE elementId(r) = ${stringLiteral(element.elementId)} RETURN r`;
}

/** Relationship counts of a node by type and direction (a READ query). */
export const NEIGHBOUR_COUNTS =
  "MATCH (n) WHERE elementId(n) = $id MATCH (n)-[r]-() " +
  "RETURN type(r) AS type, startNode(r) = n AS outgoing, count(*) AS count ORDER BY count DESC";
