/**
 * Hand-written mirror of the graph IPC contract (`graph_*` commands of the Neo4j driver).
 * Swap for the ts-rs types in `src/lib/ipc/generated` once the backend exports them; the field
 * names and shapes here are the agreed contract, so the swap should be an import change only.
 * Integers outside +-2^53 arrive as `bigint` strings (the existing `Value` kinds).
 */
import type { Value } from "../../lib/ipc/drivers";

export type GraphProps = Record<string, Value>;

export interface GraphNode {
  elementId: string;
  labels: string[];
  properties: GraphProps;
}

export interface GraphRel {
  elementId: string;
  relType: string;
  startId: string;
  endId: string;
  properties: GraphProps;
}

export type GraphNodeValue = { kind: "node" } & GraphNode;
export type GraphRelValue = { kind: "relationship" } & GraphRel;
export interface GraphPathValue {
  kind: "path";
  nodes: GraphNode[];
  relationships: GraphRel[];
}

/** A record cell: the scalar kinds of the value model plus the three graph kinds. */
export type GraphValue = Value | GraphNodeValue | GraphRelValue | GraphPathValue;

export interface PlanNode {
  operator: string;
  details: string;
  estimatedRows?: number;
  rows?: number;
  dbHits?: number;
  children: PlanNode[];
}

export interface GraphSummary {
  elapsedMs: number;
  counters: Record<string, number>;
  database: string;
}

export interface GraphResult {
  cursorId?: string;
  columns: string[];
  records: GraphValue[][];
  nodes: GraphNode[];
  relationships: GraphRel[];
  hasMore: boolean;
  summary: GraphSummary;
  plan?: PlanNode;
}

export type GraphAccess = "read" | "write";
export type GraphMode = "run" | "explain" | "profile";

export interface GraphQueryRequest {
  cypher: string;
  params: Record<string, unknown>;
  access: GraphAccess;
  mode: GraphMode;
  fetchSize: number;
}

export interface GraphCount {
  name: string;
  count: number;
}

/** An index or a constraint of the graph schema. */
export interface GraphSchemaItem {
  name: string;
  /** `RANGE`, `TEXT`, `UNIQUENESS`, `NODE_KEY`, … as the server reports it. */
  kind: string;
  labels: string[];
  properties: string[];
  state?: string;
}

export interface GraphSchema {
  labels: GraphCount[];
  relationshipTypes: GraphCount[];
  propertyKeys: string[];
  indexes: GraphSchemaItem[];
  constraints: GraphSchemaItem[];
  /** Optional: names the server reports for completion (`SHOW FUNCTIONS` / `SHOW PROCEDURES`). */
  functions?: string[];
  procedures?: string[];
}

export const isGraphValue = (v: GraphValue): v is GraphNodeValue | GraphRelValue | GraphPathValue =>
  v.kind === "node" || v.kind === "relationship" || v.kind === "path";
