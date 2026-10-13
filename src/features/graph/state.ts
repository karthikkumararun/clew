export const GRAPH_KIND = "graph-console";

export type GraphView = "graph" | "table" | "json" | "plan";
export const GRAPH_VIEWS: GraphView[] = ["graph", "table", "json", "plan"];

export const DEFAULT_PARAMS = "{}";

/** What a graph console tab keeps (and what survives a restart). */
export interface GraphTabState {
  connectionId: string;
  /** The database the session works in; empty means the connection's own. */
  database: string;
  /** The Cypher editor's text. */
  text: string;
  /** The Parameters panel: a JSON object. */
  params: string;
  paramsOpen: boolean;
  view: GraphView;
  inspectorOpen: boolean;
  /** The tab's open session; transient. */
  sessionId?: string;
  /** Run the editor's text once the tab has mounted (opened from the explorer); transient. */
  autoRun?: boolean;
}

export type GraphTab = import("../../shell/registry/tabKinds").Tab<GraphTabState>;

let counter = 0;

/** A fresh, unique key: every new Cypher console is its own tab. */
export const newGraphKey = (connectionId: string) =>
  `graph:${connectionId}:${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function serializeGraph(s: GraphTabState): GraphTabState {
  const { sessionId: _session, autoRun: _auto, ...persisted } = s;
  void _session;
  void _auto;
  return persisted;
}

export function deserializeGraph(raw: unknown): GraphTabState {
  const r = (raw ?? {}) as Partial<GraphTabState>;
  if (typeof r.connectionId !== "string") throw new Error("a graph console needs a connection");
  return {
    connectionId: r.connectionId,
    database: typeof r.database === "string" ? r.database : "",
    text: typeof r.text === "string" ? r.text : "",
    params: typeof r.params === "string" && r.params.trim() ? r.params : DEFAULT_PARAMS,
    paramsOpen: r.paramsOpen === true,
    view: GRAPH_VIEWS.includes(r.view as GraphView) ? (r.view as GraphView) : "graph",
    inspectorOpen: r.inspectorOpen !== false,
  };
}
