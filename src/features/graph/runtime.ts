/**
 * What a graph console tab holds while the app runs: its Neo4j session, the schema, the last
 * result and the graph the user has built from it (expansions, hidden nodes, selection). Lives
 * outside React like the other tab runtimes.
 */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { sessionSwitchNamespace } from "../../connections/api";
import { useConnections } from "../../connections/connectionsStore";
import { queryCancel, sessionClose, sessionOpen } from "../../lib/ipc/drivers";
import type { Value } from "../../lib/ipc/drivers";
import { getUiState, setUiState } from "../../lib/uiState";
import { useWorkspace } from "../../stores/workspaceStore";
import { confirmGuarded } from "../safety/confirm";
import { sessionReadOnly, setSessionReadOnly } from "../safety/ipc";
import {
  graphDatabases,
  graphExpand,
  graphFetchMore,
  graphQuery,
  graphSafetyCheck,
  graphUpdateSafetyCheck,
  graphSchema,
  graphUpdateProperties,
} from "./api";
import { mergeById, primaryLabel } from "./graphModel";
import type { CaptionChoices } from "./graphModel";
import { NEIGHBOUR_COUNTS } from "./cypherText";
import type { ElementKind } from "./cypherText";
import { missingParam, missingParamMessage, parseParams } from "./cypher/params";
import type { GraphTabState } from "./state";
import type { GraphMode, GraphNode, GraphRel, GraphResult, GraphSchema } from "./types";

/** Records asked of the server per batch. */
export const FETCH_SIZE = 500;
/** Relationships fetched when a node is expanded (spec: graph-browser › Graph view). */
export const EXPAND_LIMIT = 25;

export interface Selection {
  kind: ElementKind;
  id: string;
}

export interface Neighbours {
  type: string;
  outgoing: boolean;
  count: number;
}

export interface GraphRuntimeState {
  sessionId: string | null;
  readOnly: boolean;
  databases: string[] | null;
  schema: GraphSchema | null;
  schemaLoading: boolean;
  schemaError: string | null;
  running: boolean;
  /** The last run failed: why. */
  error: string | null;
  result: GraphResult | null;
  mode: GraphMode;
  /** The graph on screen: the result's elements plus expansions. */
  nodes: GraphNode[];
  relationships: GraphRel[];
  hidden: ReadonlySet<string>;
  /** Draw every node instead of the first `NODE_CAP`. */
  showAll: boolean;
  /** Bumped by every run, so the canvas knows to lay the graph out afresh. */
  epoch: number;
  selection: Selection | null;
  neighbours: Record<string, Neighbours[]>;
  expanding: string | null;
  captions: CaptionChoices;
  /** Bumped to ask the Parameters panel to take focus. */
  paramsFocus: number;
  /** A message about the parameters (invalid JSON, a missing value). */
  paramsError: string | null;
  /** The last edit or expansion failed: why. */
  actionError: string | null;
  loadingMore: boolean;
}

const INITIAL: GraphRuntimeState = {
  sessionId: null,
  readOnly: false,
  databases: null,
  schema: null,
  schemaLoading: false,
  schemaError: null,
  running: false,
  error: null,
  result: null,
  mode: "run",
  nodes: [],
  relationships: [],
  hidden: new Set(),
  showAll: false,
  epoch: 0,
  selection: null,
  neighbours: {},
  expanding: null,
  captions: {},
  paramsFocus: 0,
  paramsError: null,
  actionError: null,
  loadingMore: false,
};

export const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);

const captionKey = (connectionId: string, label: string) =>
  `graph.caption.${connectionId}.${label}`;

/** A JavaScript value as the value model, to show an edited property before a re-run. */
export function toValue(x: unknown): Value {
  if (x === null || x === undefined) return { kind: "null" };
  if (typeof x === "boolean") return { kind: "bool", value: x };
  if (typeof x === "number") {
    return Number.isInteger(x) ? { kind: "int", value: x } : { kind: "float", value: x };
  }
  if (typeof x === "string") return { kind: "text", value: x };
  if (Array.isArray(x)) return { kind: "array", value: x.map(toValue) };
  return { kind: "json", value: x as never };
}

/** Counters that say a statement changed the graph, so the schema is stale. */
export const changedGraph = (r: GraphResult) =>
  Object.entries(r.summary.counters).some(([k, v]) => v > 0 && !/^contains|^system/i.test(k));

export class GraphRuntime {
  readonly store: StoreApi<GraphRuntimeState> = createStore<GraphRuntimeState>(() => ({
    ...INITIAL,
  }));
  private opening: Promise<string> | null = null;
  private closed = false;
  private runId = 0;
  private schemaId = 0;
  private database = "";

  constructor(
    readonly tabId: string,
    readonly connectionId: string,
  ) {
    const saved = useConnections.getState().file.connections.find((c) => c.id === connectionId);
    this.store.setState({ readOnly: saved?.safeguards.readOnlyByDefault ?? false });
  }

  get sessionId(): string | null {
    return this.store.getState().sessionId;
  }

  /** Open the session on first use, in the database the tab is set to. */
  ensureSession(database = ""): Promise<string> {
    const existing = this.sessionId;
    if (existing) return Promise.resolve(existing);
    if (this.opening) return this.opening;
    this.database = database || this.database;
    const attempt = (async () => {
      if (!(await useConnections.getState().connect(this.connectionId))) {
        throw new Error("The connection isn't available");
      }
      const opened = await sessionOpen(this.connectionId);
      if (this.closed) {
        void sessionClose(opened.sessionId).catch(() => {});
        throw new Error("The graph console was closed");
      }
      this.store.setState({ sessionId: opened.sessionId });
      try {
        this.store.setState({ readOnly: await sessionReadOnly(opened.sessionId) });
      } catch {
        /* keep the connection's default */
      }
      if (this.database) {
        try {
          await sessionSwitchNamespace(opened.sessionId, { database: this.database });
        } catch (e) {
          this.store.setState({ actionError: messageOf(e) });
        }
      }
      if (useWorkspace.getState().tabs.some((t) => t.id === this.tabId)) {
        useWorkspace
          .getState()
          .updateTabState<Partial<GraphTabState>>(this.tabId, { sessionId: opened.sessionId });
      }
      return opened.sessionId;
    })();
    this.opening = attempt;
    const clear = () => (this.opening = null);
    attempt.then(clear, clear);
    return attempt;
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    try {
      const sessionId = await this.ensureSession();
      await setSessionReadOnly(sessionId, readOnly);
      this.store.setState({ readOnly });
    } catch (e) {
      this.store.setState({ actionError: messageOf(e) });
    }
  }

  // ---- schema and databases -------------------------------------------------------------------

  async loadDatabases(): Promise<void> {
    try {
      this.store.setState({ databases: await graphDatabases(this.connectionId) });
    } catch {
      /* the breadcrumb shows the current database only */
    }
  }

  async loadSchema(database: string): Promise<void> {
    const id = ++this.schemaId;
    this.store.setState({ schemaLoading: true, schemaError: null });
    try {
      const schema = await graphSchema(this.connectionId, database || undefined);
      if (id !== this.schemaId) return;
      this.store.setState({ schema, schemaLoading: false });
    } catch (e) {
      if (id !== this.schemaId) return;
      this.store.setState({ schemaLoading: false, schemaError: messageOf(e) });
    }
  }

  /** Switch the session to another database; the schema reloads. */
  async switchDatabase(database: string): Promise<boolean> {
    try {
      const sessionId = await this.ensureSession(database);
      await sessionSwitchNamespace(sessionId, { database });
    } catch (e) {
      this.store.setState({ actionError: messageOf(e) });
      return false;
    }
    this.database = database;
    this.clearResult();
    this.store.setState({ schema: null });
    void this.loadSchema(database);
    return true;
  }

  // ---- running --------------------------------------------------------------------------------

  /**
   * Run Cypher: check the parameters, ask the safeguards, confirm when they say so, send it with
   * their token. Resolves false when nothing ran (a missing parameter, a declined confirmation).
   */
  async run(cypher: string, paramsText: string, mode: GraphMode = "run"): Promise<boolean> {
    const parsed = parseParams(paramsText);
    if (!parsed.ok) {
      this.store.setState((s) => ({
        paramsError: parsed.message,
        paramsFocus: s.paramsFocus + 1,
      }));
      return false;
    }
    const missing = missingParam(cypher, parsed.value);
    if (missing !== null) {
      this.store.setState((s) => ({
        paramsError: missingParamMessage(missing),
        paramsFocus: s.paramsFocus + 1,
      }));
      return false;
    }
    const id = ++this.runId;
    this.store.setState({ paramsError: null, error: null, actionError: null, running: true });
    try {
      const sessionId = await this.ensureSession();
      const report = await graphSafetyCheck(sessionId, cypher);
      if (id !== this.runId) return false;
      if (report.decision === "block") {
        throw { code: "read_only", message: report.reason ?? "This session is read-only" };
      }
      let token: string | undefined;
      if (report.decision === "confirm" || report.decision === "typed_confirm") {
        if (!(await confirmGuarded(report))) {
          this.store.setState({ running: false });
          return false;
        }
        token = report.token;
      }
      const result = await graphQuery(
        sessionId,
        {
          cypher,
          params: parsed.value,
          access: this.store.getState().readOnly ? "read" : "write",
          mode,
          fetchSize: FETCH_SIZE,
        },
        token,
      );
      if (id !== this.runId) return false;
      this.acceptResult(result, mode);
      if (changedGraph(result)) void this.loadSchema(this.database);
      return true;
    } catch (e) {
      if (id !== this.runId) return false;
      this.store.setState({ running: false, error: messageOf(e) });
      return false;
    }
  }

  private acceptResult(result: GraphResult, mode: GraphMode) {
    const captions: CaptionChoices = {};
    for (const n of result.nodes) {
      const label = primaryLabel(n);
      if (label && !(label in captions)) {
        captions[label] = getUiState(captionKey(this.connectionId, label)) ?? undefined;
      }
    }
    this.store.setState((s) => ({
      running: false,
      error: null,
      result,
      mode,
      nodes: result.nodes,
      relationships: result.relationships,
      hidden: new Set(),
      showAll: false,
      epoch: s.epoch + 1,
      selection: null,
      neighbours: {},
      captions: { ...s.captions, ...captions },
    }));
  }

  /** Ask the server to stop the running statement. */
  async cancel(): Promise<void> {
    const sessionId = this.sessionId;
    if (!sessionId || !this.store.getState().running) return;
    this.runId += 1;
    this.store.setState({ running: false });
    try {
      await queryCancel(sessionId);
    } catch {
      /* the run is abandoned either way */
    }
  }

  /** The next batch of records of the open result. */
  async loadMore(): Promise<void> {
    const { result, loadingMore } = this.store.getState();
    const sessionId = this.sessionId;
    if (!result?.cursorId || !result.hasMore || loadingMore || !sessionId) return;
    this.store.setState({ loadingMore: true });
    try {
      const more = await graphFetchMore(sessionId, result.cursorId);
      this.store.setState((s) => ({
        loadingMore: false,
        result: s.result
          ? {
              ...s.result,
              cursorId: more.cursorId,
              hasMore: more.hasMore,
              records: [...s.result.records, ...more.records],
              nodes: mergeById(s.result.nodes, more.nodes),
              relationships: mergeById(s.result.relationships, more.relationships),
            }
          : s.result,
        nodes: mergeById(s.nodes, more.nodes),
        relationships: mergeById(s.relationships, more.relationships),
      }));
    } catch (e) {
      this.store.setState({ loadingMore: false, actionError: messageOf(e) });
    }
  }

  // ---- the graph --------------------------------------------------------------------------------

  /** Add the neighbours of a node (a READ query of up to `EXPAND_LIMIT` relationships). */
  async expand(elementId: string): Promise<void> {
    if (this.store.getState().expanding) return;
    this.store.setState({ expanding: elementId, actionError: null });
    try {
      const sessionId = await this.ensureSession();
      const more = await graphExpand(sessionId, elementId, EXPAND_LIMIT);
      this.store.setState((s) => ({
        expanding: null,
        nodes: mergeById(s.nodes, more.nodes),
        relationships: mergeById(s.relationships, more.relationships),
      }));
    } catch (e) {
      this.store.setState({ expanding: null, actionError: messageOf(e) });
    }
  }

  hide(elementId: string): void {
    this.store.setState((s) => {
      const hidden = new Set(s.hidden);
      hidden.add(elementId);
      const selection = s.selection?.id === elementId ? null : s.selection;
      return { hidden, selection };
    });
  }

  unhideAll(): void {
    this.store.setState({ hidden: new Set() });
  }

  setShowAll(showAll: boolean): void {
    this.store.setState({ showAll });
  }

  select(selection: Selection | null): void {
    this.store.setState({ selection, actionError: null });
    if (selection?.kind === "node") void this.loadNeighbours(selection.id);
  }

  /** Relationship counts of a node by type and direction, for the inspector. */
  async loadNeighbours(elementId: string): Promise<void> {
    if (elementId in this.store.getState().neighbours) return;
    try {
      const sessionId = await this.ensureSession();
      const r = await graphQuery(sessionId, {
        cypher: NEIGHBOUR_COUNTS,
        params: { id: elementId },
        access: "read",
        mode: "run",
        fetchSize: 100,
      });
      const rows: Neighbours[] = r.records.map((row) => ({
        type: row[0]?.kind === "text" ? row[0].value : "?",
        outgoing: row[1]?.kind === "bool" ? row[1].value : true,
        count: Number(
          row[2] && (row[2].kind === "int" || row[2].kind === "bigint") ? row[2].value : 0,
        ),
      }));
      this.store.setState((s) => ({ neighbours: { ...s.neighbours, [elementId]: rows } }));
    } catch {
      this.store.setState((s) => ({ neighbours: { ...s.neighbours, [elementId]: [] } }));
    }
  }

  /** Remember which property captions the nodes of a label. */
  setCaption(label: string, key: string | undefined): void {
    setUiState(captionKey(this.connectionId, label), key ?? "");
    this.store.setState((s) => ({ captions: { ...s.captions, [label]: key || undefined } }));
  }

  clearResult(): void {
    this.runId += 1;
    this.store.setState((s) => ({
      running: false,
      error: null,
      result: null,
      nodes: [],
      relationships: [],
      hidden: new Set(),
      showAll: false,
      epoch: s.epoch + 1,
      selection: null,
      neighbours: {},
    }));
  }

  // ---- editing ----------------------------------------------------------------------------------

  /**
   * Set properties of a node or relationship through the safeguards (spec: graph-browser ›
   * Inspector). Resolves false when the user declined; errors land in `actionError`.
   */
  async updateProperties(
    kind: ElementKind,
    elementId: string,
    changes: Record<string, unknown>,
  ): Promise<boolean> {
    this.store.setState({ actionError: null });
    try {
      const sessionId = await this.ensureSession();
      const report = await graphUpdateSafetyCheck(sessionId, kind);
      if (report.decision === "block") {
        throw { code: "read_only", message: report.reason ?? "This session is read-only" };
      }
      let token: string | undefined;
      if (report.decision === "confirm" || report.decision === "typed_confirm") {
        if (!(await confirmGuarded(report))) return false;
        token = report.token;
      }
      await graphUpdateProperties(sessionId, elementId, changes, kind, token);
    } catch (e) {
      this.store.setState({ actionError: messageOf(e) });
      return false;
    }
    const patch = <T extends { elementId: string; properties: Record<string, Value> }>(x: T): T =>
      x.elementId === elementId
        ? {
            ...x,
            properties: {
              ...x.properties,
              ...Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, toValue(v)])),
            },
          }
        : x;
    this.store.setState((s) => ({
      nodes: s.nodes.map(patch),
      relationships: s.relationships.map(patch),
    }));
    void this.loadSchema(this.database);
    return true;
  }

  close(): void {
    this.closed = true;
    this.runId += 1;
    this.schemaId += 1;
    const id = this.sessionId;
    this.store.setState({ ...INITIAL, hidden: new Set() });
    if (id) void sessionClose(id).catch(() => {});
  }
}

const runtimes = new Map<string, GraphRuntime>();

export function getGraphRuntime(tabId: string, connectionId: string): GraphRuntime {
  let r = runtimes.get(tabId);
  if (!r) {
    r = new GraphRuntime(tabId, connectionId);
    runtimes.set(tabId, r);
  }
  return r;
}

export const peekGraphRuntime = (tabId: string) => runtimes.get(tabId);

export function disposeGraphRuntime(tabId: string): void {
  runtimes.get(tabId)?.close();
  runtimes.delete(tabId);
}

/** Test helper. */
export function clearGraphRuntimes(): void {
  for (const r of runtimes.values()) r.close();
  runtimes.clear();
}
