/**
 * Pure model of the graph view: captions, the cap on drawn nodes and the mapping from the
 * distinct nodes and relationships of a result to Cytoscape elements.
 */
import type { ElementDefinition } from "cytoscape";
import type { Value } from "../../lib/ipc/drivers";
import { valueText } from "../console/valueFormat";
import { tokenOfLabel } from "./palette";
import type { LabelToken } from "./palette";
import type { GraphNode, GraphRel, GraphResult, GraphValue } from "./types";

/** Nodes drawn at most before the "Showing 300 of N nodes" notice. */
export const NODE_CAP = 300;

export const primaryLabel = (n: GraphNode): string => n.labels[0] ?? "";

/** Per-label caption property chosen by the user (label -> property key). */
export type CaptionChoices = Record<string, string | undefined>;

const textOf = (v: Value | undefined): string | null => {
  if (!v || v.kind === "null") return null;
  const t = valueText(v);
  return t === null || t === "" ? null : t;
};

/** The caption of a node: the chosen property, else `name`, `title`, the first string, the id. */
export function captionOf(node: GraphNode, choices: CaptionChoices = {}): string {
  const chosen = choices[primaryLabel(node)];
  if (chosen) {
    const t = textOf(node.properties[chosen]);
    if (t !== null) return t;
  }
  for (const key of ["name", "title"]) {
    const v = node.properties[key];
    if (v && v.kind === "text" && v.value !== "") return v.value;
  }
  for (const v of Object.values(node.properties)) {
    if (v.kind === "text" && v.value !== "") return v.value;
  }
  return node.elementId;
}

export interface LegendEntry {
  name: string;
  count: number;
}

export interface BuiltGraph {
  elements: ElementDefinition[];
  /** Ids of the drawn nodes, in the order they were first seen. */
  shown: string[];
  /** Distinct visible (not hidden) nodes, drawn or not. */
  total: number;
  /** Relationships drawn. */
  edges: number;
  labels: (LegendEntry & { token: LabelToken })[];
  types: LegendEntry[];
}

export interface BuildOptions {
  /** Draw at most this many nodes; `null` draws all. */
  cap: number | null;
  hidden: ReadonlySet<string>;
  captions: CaptionChoices;
}

/** GraphResult elements -> Cytoscape elements (spec: graph-browser › Graph view). */
export function buildGraph(
  nodes: readonly GraphNode[],
  relationships: readonly GraphRel[],
  opts: BuildOptions,
): BuiltGraph {
  const visible = nodes.filter((n) => !opts.hidden.has(n.elementId));
  const drawn = opts.cap === null ? visible : visible.slice(0, opts.cap);
  const ids = new Set(drawn.map((n) => n.elementId));

  const elements: ElementDefinition[] = [];
  const labelCounts = new Map<string, number>();
  for (const n of drawn) {
    const label = primaryLabel(n);
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    elements.push({
      group: "nodes",
      data: {
        id: n.elementId,
        caption: captionOf(n, opts.captions),
        label,
        token: tokenOfLabel(label),
      },
    });
  }
  const typeCounts = new Map<string, number>();
  const seen = new Set<string>();
  let edges = 0;
  for (const r of relationships) {
    if (seen.has(r.elementId) || !ids.has(r.startId) || !ids.has(r.endId)) continue;
    seen.add(r.elementId);
    edges += 1;
    typeCounts.set(r.relType, (typeCounts.get(r.relType) ?? 0) + 1);
    elements.push({
      group: "edges",
      data: { id: r.elementId, source: r.startId, target: r.endId, type: r.relType },
    });
  }
  return {
    elements,
    shown: drawn.map((n) => n.elementId),
    total: visible.length,
    edges,
    labels: [...labelCounts].map(([name, count]) => ({ name, count, token: tokenOfLabel(name) })),
    types: [...typeCounts].map(([name, count]) => ({ name, count })),
  };
}

/** Add `incoming` to a keyed list, keeping first-seen order and ignoring ids already there. */
export function mergeById<T extends { elementId: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const have = new Set(current.map((x) => x.elementId));
  const out = [...current];
  for (const x of incoming) {
    if (have.has(x.elementId)) continue;
    have.add(x.elementId);
    out.push(x);
  }
  return out;
}

export const hasGraphElements = (r: Pick<GraphResult, "nodes" | "relationships">): boolean =>
  r.nodes.length > 0 || r.relationships.length > 0;

// ---- table and JSON cells --------------------------------------------------------------------

/** `(:User {name: "Ada"})`, `[:PURCHASED]` or the scalar's text, as a table cell shows it. */
export function cellSummary(v: GraphValue, captions: CaptionChoices = {}): string {
  switch (v.kind) {
    case "node": {
      const labels = v.labels.map((l) => `:${l}`).join("");
      const key = captions[primaryLabel(v)] ?? ["name", "title"].find((k) => k in v.properties);
      const t = key ? textOf(v.properties[key]) : null;
      return t === null || !key ? `(${labels})` : `(${labels} {${key}: ${JSON.stringify(t)}})`;
    }
    case "relationship":
      return `[:${v.relType}]`;
    case "path":
      return `<path: ${v.nodes.length} ${v.nodes.length === 1 ? "node" : "nodes"}, ${v.relationships.length} ${v.relationships.length === 1 ? "relationship" : "relationships"}>`;
    default:
      return valueText(v) ?? "null";
  }
}

const jsonProps = (p: Record<string, Value>) =>
  Object.fromEntries(Object.entries(p).map(([k, v]) => [k, jsonOf(v)]));

/** A record cell as plain JSON (large integers stay strings). */
export function jsonOf(v: GraphValue): unknown {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
    case "int":
    case "float":
      return v.value;
    case "json":
      return v.value;
    case "array":
      return v.value.map(jsonOf);
    case "bytes":
      return `<${v.len} bytes>`;
    case "node":
      return {
        type: "node",
        elementId: v.elementId,
        labels: v.labels,
        properties: jsonProps(v.properties),
      };
    case "relationship":
      return {
        type: "relationship",
        elementId: v.elementId,
        relType: v.relType,
        startId: v.startId,
        endId: v.endId,
        properties: jsonProps(v.properties),
      };
    case "path":
      return {
        type: "path",
        nodes: v.nodes.map((n) => jsonOf({ kind: "node", ...n })),
        relationships: v.relationships.map((r) => jsonOf({ kind: "relationship", ...r })),
      };
    default:
      return v.value;
  }
}

/** The records of a result as `{column: value}` objects. */
export function recordsAsJson(r: Pick<GraphResult, "columns" | "records">): unknown[] {
  return r.records.map((row) =>
    Object.fromEntries(r.columns.map((c, i) => [c, row[i] ? jsonOf(row[i]) : null])),
  );
}
