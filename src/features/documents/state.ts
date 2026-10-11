import { nodeId } from "../explorer/tree";
import type { NodePath } from "../../lib/ipc/drivers";

export const COLLECTION_KIND = "collection";

export type CollectionPane = "documents" | "schema" | "indexes" | "aggregation";
export type DocView = "tree" | "table" | "json";

export const PAGE_SIZE = 50;
export const DEFAULT_SORT = "{ _id: -1 }";
export const DEFAULT_PIPELINE = "[\n  { $match: {} },\n  { $limit: 20 }\n]";

/** What a collection tab keeps. */
export interface CollectionTabState {
  connectionId: string;
  database: string;
  collection: string;
  filter: string;
  project: string;
  sort: string;
  /** 0 = no limit. */
  limit: number;
  /** The aggregation pipeline text of the Aggregation view. */
  pipeline: string;
  pane: CollectionPane;
  docView: DocView;
  /** The tab's open session; transient. */
  sessionId?: string;
}

export type CollectionTab = import("../../shell/registry/tabKinds").Tab<CollectionTabState>;

export const collectionPath = (database: string, collection: string): NodePath => [
  { kind: "database", name: database },
  { kind: "table", name: collection },
];

export const collectionKey = (connectionId: string, database: string, collection: string) =>
  `collection:${nodeId(connectionId, collectionPath(database, collection))}`;

export function serializeCollection(s: CollectionTabState): CollectionTabState {
  const { sessionId: _session, ...persisted } = s;
  void _session;
  return persisted;
}

export function deserializeCollection(raw: unknown): CollectionTabState {
  const r = (raw ?? {}) as Partial<CollectionTabState>;
  if (
    typeof r.connectionId !== "string" ||
    typeof r.database !== "string" ||
    typeof r.collection !== "string"
  ) {
    throw new Error("a collection tab needs a connection, a database and a collection");
  }
  const panes: CollectionPane[] = ["documents", "schema", "indexes", "aggregation"];
  const views: DocView[] = ["tree", "table", "json"];
  return {
    connectionId: r.connectionId,
    database: r.database,
    collection: r.collection,
    filter: typeof r.filter === "string" ? r.filter : "",
    project: typeof r.project === "string" ? r.project : "",
    sort: typeof r.sort === "string" ? r.sort : DEFAULT_SORT,
    limit: typeof r.limit === "number" && r.limit >= 0 ? Math.floor(r.limit) : 0,
    pipeline: typeof r.pipeline === "string" && r.pipeline ? r.pipeline : DEFAULT_PIPELINE,
    pane: panes.includes(r.pane as CollectionPane) ? (r.pane as CollectionPane) : "documents",
    docView: views.includes(r.docView as DocView) ? (r.docView as DocView) : "tree",
  };
}
