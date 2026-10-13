/** Typed bindings for the graph commands (`src-tauri/src/commands/graph.rs`). */
import { invoke } from "../../lib/ipc";
import type { GuardReport } from "../../lib/ipc/generated/GuardReport";
import type { GraphQueryRequest, GraphResult, GraphSchema } from "./types";

export type { GraphQueryRequest, GraphResult, GraphSchema };

/** Run Cypher. `confirmationToken` answers a confirmation dialog (see `graphSafetyCheck`). */
export const graphQuery = (
  sessionId: string,
  request: GraphQueryRequest,
  confirmationToken?: string,
) =>
  invoke<GraphResult>("graph_query", {
    sessionId,
    request,
    ...(confirmationToken ? { confirmationToken } : {}),
  });

/** The next batch of an open result; elements and records are the new ones only. */
export const graphFetchMore = (sessionId: string, cursorId: string) =>
  invoke<GraphResult>("graph_fetch_more", { sessionId, cursorId });

/** The neighbours of a node (a READ query, `limit` relationships). */
export const graphExpand = (sessionId: string, elementId: string, limit: number) =>
  invoke<GraphResult>("graph_expand", { sessionId, elementId, limit });

export const graphSchema = (connectionId: string, database?: string) =>
  invoke<GraphSchema>("graph_schema", { connectionId, ...(database ? { database } : {}) });

/** Database names; the driver may send bare names or `{ name }` objects. */
export const graphDatabases = async (connectionId: string): Promise<string[]> => {
  const rows = await invoke<Array<string | { name: string }>>("graph_databases", { connectionId });
  return rows.map((r) => (typeof r === "string" ? r : r.name));
};

/** Replace properties of one node or relationship (a parameterised `SET`). */
export const graphUpdateProperties = (
  sessionId: string,
  elementId: string,
  properties: Record<string, unknown>,
  /** Not in the agreed contract: lets the driver pick `(n)` or `()-[r]->()` without guessing. */
  kind: "node" | "relationship",
  confirmationToken?: string,
) =>
  invoke<void>("graph_update_properties", {
    sessionId,
    elementId,
    properties,
    kind,
    ...(confirmationToken ? { confirmationToken } : {}),
  });

/** What the safeguards say about Cypher before it is sent. */
export const graphSafetyCheck = (sessionId: string, cypher: string) =>
  invoke<GuardReport>("safety_check", { sessionId, sql: cypher, script: false });

/** What the safeguards say about a property edit; its token is the one `graphUpdateProperties` takes. */
export const graphUpdateSafetyCheck = (sessionId: string, kind: "node" | "relationship") =>
  invoke<GuardReport>("graph_update_safety_check", { sessionId, kind });
