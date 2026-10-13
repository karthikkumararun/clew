/**
 * What an explorer node of a Neo4j connection opens (spec: graph-browser › Explorer, palette and
 * AI integration): a database opens a Cypher console, a label or relationship type opens one
 * with its query already run. The tree is databases → Node labels / Relationship types / Indexes.
 */
import type { NodePath } from "../../lib/ipc/drivers";
import { labelQuery, relTypeQuery } from "./cypherText";

export interface GraphTarget {
  kind: "database" | "label" | "relationshipType";
  database?: string;
  /** The label or type name. */
  name: string;
  cypher?: string;
}

const groupOf = (path: NodePath) => path[path.length - 2];

/** The graph meaning of an explorer node, or `null` when it opens nothing. */
export function graphTargetOf(path: NodePath, kind: string): GraphTarget | null {
  const last = path[path.length - 1];
  if (!last) return null;
  const database = path.find((p) => p.kind === "database")?.name;
  if (kind === "database") return { kind: "database", database: last.name, name: last.name };
  const group = groupOf(path);
  if (group?.kind !== "group") return null;
  if (/label/i.test(group.name)) {
    return { kind: "label", database, name: last.name, cypher: labelQuery(last.name) };
  }
  if (/relationship/i.test(group.name)) {
    return {
      kind: "relationshipType",
      database,
      name: last.name,
      cypher: relTypeQuery(last.name),
    };
  }
  return null;
}
