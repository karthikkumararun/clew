/**
 * What a collection tab holds while the app runs: its database session, the loaded documents and
 * their open cursor, staged edits, the inferred schema and the indexes. Like the other tab
 * runtimes it lives outside React, so a load keeps going while another tab is on screen.
 */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { useConnections } from "../../connections/connectionsStore";
import { queryCancel, sessionClose, sessionOpen } from "../../lib/ipc/drivers";
import { askChoice } from "../console/prompts";
import { confirmGuarded } from "../safety/confirm";
import { sessionReadOnly, setSessionReadOnly } from "../safety/ipc";
import { useWorkspace } from "../../stores/workspaceStore";
import { docCall, docFetchMore, docSafetyCheck } from "./api";
import type { DocReply, DocRequest, ExportFormat, FieldCheck, IndexInfo, SchemaField } from "./api";
import { dottable, getAt, idOf, setAt } from "./ejson";
import type { EJson } from "./ejson";
import { PAGE_SIZE } from "./state";
import type { CollectionTabState } from "./state";

export interface QueryError {
  message: string;
  /** Which query-bar field the message is about, when it says. */
  field?: "filter" | "project" | "sort" | "pipeline";
  position?: number;
}

export interface Matched {
  count: number;
  capped: boolean;
}

export interface CollectionRuntimeState {
  sessionId: string | null;
  readOnly: boolean;
  loading: boolean;
  loaded: boolean;
  error: QueryError | null;
  docs: EJson[];
  resultId: number | null;
  hasMore: boolean;
  fetching: boolean;
  matched: Matched | null;
  elapsedMs: number | null;
  plan: { index: string | null; collscan: boolean } | null;
  /** Bumped whenever staged edits change, so views re-render. */
  pendingVersion: number;
  saving: boolean;
  saveError: string | null;
  schema: { sampled: number; fields: SchemaField[] } | null;
  schemaLoading: boolean;
  schemaError: string | null;
  indexes: IndexInfo[] | null;
  indexesError: string | null;
}

const INITIAL: CollectionRuntimeState = {
  sessionId: null,
  readOnly: false,
  loading: false,
  loaded: false,
  error: null,
  docs: [],
  resultId: null,
  hasMore: false,
  fetching: false,
  matched: null,
  elapsedMs: null,
  plan: null,
  pendingVersion: 0,
  saving: false,
  saveError: null,
  schema: null,
  schemaLoading: false,
  schemaError: null,
  indexes: null,
  indexesError: null,
};

/** Counting stops here; "100,000+" is as exact as anyone needs. */
export const COUNT_CAP = 100_000;

export const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);

/** The query-bar field and character position an error names (see the driver's parse errors). */
export function queryErrorOf(e: unknown): QueryError {
  const message = messageOf(e);
  const detail =
    typeof e === "object" && e !== null && "detail" in e
      ? String((e as { detail?: unknown }).detail ?? "")
      : "";
  const fields: Record<string, QueryError["field"]> = {
    Filter: "filter",
    Project: "project",
    Sort: "sort",
    Pipeline: "pipeline",
  };
  const prefix = /^(Filter|Project|Sort|Pipeline): /.exec(message)?.[1];
  const position = /^position:(\d+)$/m.exec(detail)?.[1];
  return {
    message: prefix ? message.slice(prefix.length + 2) : message,
    ...(prefix ? { field: fields[prefix] } : {}),
    ...(position ? { position: Number(position) } : {}),
  };
}

export interface PendingDoc {
  id: EJson;
  original: EJson;
  set: Map<string, { path: string[]; value: EJson }>;
  unset: Map<string, string[]>;
}

const pathKey = (path: string[]) => JSON.stringify(path);
const docKey = (id: EJson | undefined) => JSON.stringify(id ?? null);

export class CollectionRuntime {
  readonly store: StoreApi<CollectionRuntimeState> = createStore<CollectionRuntimeState>(() => ({
    ...INITIAL,
  }));
  /** Staged edits by document `_id`. */
  readonly pending = new Map<string, PendingDoc>();
  private opening: Promise<string> | null = null;
  private runId = 0;
  private closed = false;
  private lastQuery: Pick<CollectionTabState, "filter" | "project" | "sort" | "limit"> | null =
    null;
  private loadedKey: string | null = null;

  constructor(
    readonly tabId: string,
    readonly connectionId: string,
    readonly database: string,
    readonly collection: string,
  ) {
    const saved = useConnections.getState().file.connections.find((c) => c.id === connectionId);
    this.store.setState({ readOnly: saved?.safeguards.readOnlyByDefault ?? false });
  }

  get sessionId(): string | null {
    return this.store.getState().sessionId;
  }

  ensureSession(): Promise<string> {
    const existing = this.sessionId;
    if (existing) return Promise.resolve(existing);
    if (this.opening) return this.opening;
    const attempt = (async () => {
      if (!(await useConnections.getState().connect(this.connectionId))) {
        throw new Error("The connection isn't available");
      }
      const opened = await sessionOpen(this.connectionId);
      if (this.closed) {
        void sessionClose(opened.sessionId).catch(() => {});
        throw new Error("The collection was closed");
      }
      this.store.setState({ sessionId: opened.sessionId });
      try {
        this.store.setState({ readOnly: await sessionReadOnly(opened.sessionId) });
      } catch {
        /* keep the connection's default */
      }
      if (useWorkspace.getState().tabs.some((t) => t.id === this.tabId)) {
        useWorkspace
          .getState()
          .updateTabState<Partial<CollectionTabState>>(this.tabId, { sessionId: opened.sessionId });
      }
      return opened.sessionId;
    })();
    this.opening = attempt;
    const clear = () => (this.opening = null);
    attempt.then(clear, clear);
    return attempt;
  }

  /** The connection dropped: the session is gone; the next call opens another. */
  sessionLost(): void {
    this.runId += 1;
    this.store.setState({ sessionId: null, loading: false, fetching: false });
  }

  private call(
    request: DocRequest,
    onDocuments?: (resultId: number, docs: EJson[]) => void,
    token?: string,
  ): Promise<DocReply> {
    return this.ensureSession().then((id) =>
      docCall(id, request, onDocuments, token).catch((e) => {
        if ((e as { code?: string })?.code === "connection_lost") this.sessionLost();
        throw e;
      }),
    );
  }

  /** Run a request that writes: ask the safeguards first, then send it with their token. */
  private async guarded(request: DocRequest): Promise<DocReply | null> {
    const sessionId = await this.ensureSession();
    const report = await docSafetyCheck(sessionId, request);
    if (report.decision === "block") {
      throw { code: "read_only", message: report.reason ?? "This session is read-only" };
    }
    let token: string | undefined;
    if (report.decision === "confirm" || report.decision === "typed_confirm") {
      if (!(await confirmGuarded(report))) return null;
      token = report.token;
    }
    return this.call(request, undefined, token);
  }

  /** Load the first page unless it is already what is on screen (switching back to the tab). */
  async findIfNeeded(q: Pick<CollectionTabState, "filter" | "project" | "sort" | "limit">) {
    if (this.store.getState().loaded && this.loadedKey === JSON.stringify(q)) return true;
    return this.find(q);
  }

  /** Run the query bar. A filter the server (or the parser) rejects leaves the old rows. */
  async find(
    q: Pick<CollectionTabState, "filter" | "project" | "sort" | "limit">,
  ): Promise<boolean> {
    const id = ++this.runId;
    this.lastQuery = q;
    this.store.setState({ loading: true, error: null });
    const request: DocRequest = {
      op: "find",
      database: this.database,
      collection: this.collection,
      filter: q.filter,
      projection: q.project,
      sort: q.sort,
      skip: 0,
      limit: q.limit,
      page_size: PAGE_SIZE,
    };
    const docs: EJson[] = [];
    try {
      const reply = await this.call(request, (_r, d) => docs.push(...d));
      if (id !== this.runId) return false;
      if (reply.kind !== "found") throw new Error("Unexpected reply");
      this.pending.clear();
      this.loadedKey = JSON.stringify(q);
      this.store.setState((s) => ({
        loading: false,
        loaded: true,
        docs,
        resultId: reply.result_id,
        hasMore: reply.has_more,
        elapsedMs: reply.elapsed_ms,
        matched: null,
        plan: null,
        pendingVersion: s.pendingVersion + 1,
      }));
      void this.measure(id, q);
      return true;
    } catch (e) {
      if (id !== this.runId) return false;
      this.store.setState({ loading: false, error: queryErrorOf(e) });
      return false;
    }
  }

  /** Count the matches and read the plan, off the critical path. */
  private async measure(id: number, q: Pick<CollectionTabState, "filter" | "sort">) {
    const [count, explain] = await Promise.allSettled([
      this.call({
        op: "count",
        database: this.database,
        collection: this.collection,
        filter: q.filter,
        cap: COUNT_CAP,
      }),
      this.call({
        op: "explain",
        database: this.database,
        collection: this.collection,
        filter: q.filter,
        sort: q.sort,
      }),
    ]);
    if (id !== this.runId) return;
    const patch: Partial<CollectionRuntimeState> = {};
    if (count.status === "fulfilled" && count.value.kind === "count") {
      patch.matched = { count: count.value.count, capped: count.value.capped };
    }
    if (explain.status === "fulfilled" && explain.value.kind === "explain") {
      patch.plan = { index: explain.value.index, collscan: explain.value.collscan };
    }
    this.store.setState(patch);
  }

  /** Read the next page of the open cursor. */
  async loadMore(): Promise<void> {
    const { resultId, hasMore, fetching, sessionId } = this.store.getState();
    if (!hasMore || fetching || resultId === null || !sessionId) return;
    const id = this.runId;
    this.store.setState({ fetching: true });
    const page: EJson[] = [];
    try {
      const more = await docFetchMore(sessionId, resultId, PAGE_SIZE, (d) => page.push(...d));
      if (id !== this.runId) return;
      this.store.setState((s) => ({ docs: [...s.docs, ...page], hasMore: more, fetching: false }));
    } catch (e) {
      if (id !== this.runId) return;
      this.store.setState({ fetching: false, hasMore: false, error: queryErrorOf(e) });
    }
  }

  async cancel(): Promise<void> {
    const id = this.sessionId;
    if (id) await queryCancel(id).catch(() => {});
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    try {
      const sessionId = await this.ensureSession();
      await setSessionReadOnly(sessionId, readOnly);
      this.store.setState({ readOnly });
    } catch (e) {
      this.store.setState({ saveError: messageOf(e) });
    }
  }

  // ---- staged edits ------------------------------------------------------------------------------

  private touch() {
    this.store.setState((s) => ({ pendingVersion: s.pendingVersion + 1, saveError: null }));
  }

  private pendingFor(doc: EJson): PendingDoc | null {
    const id = idOf(doc);
    if (id === undefined) return null;
    const key = docKey(id);
    let p = this.pending.get(key);
    if (!p) {
      p = { id, original: doc, set: new Map(), unset: new Map() };
      this.pending.set(key, p);
    }
    return p;
  }

  /** Stage a new value at `path`. Setting back the original drops the edit. */
  stageSet(doc: EJson, path: string[], value: EJson): void {
    const p = this.pendingFor(doc);
    if (!p) return;
    const k = pathKey(path);
    p.unset.delete(k);
    if (JSON.stringify(getAt(p.original, path)) === JSON.stringify(value)) p.set.delete(k);
    else p.set.set(k, { path, value });
    this.prune(p);
    this.touch();
  }

  stageUnset(doc: EJson, path: string[]): void {
    const p = this.pendingFor(doc);
    if (!p) return;
    const k = pathKey(path);
    p.set.delete(k);
    if (getAt(p.original, path) === undefined) p.unset.delete(k);
    else p.unset.set(k, path);
    this.prune(p);
    this.touch();
  }

  private prune(p: PendingDoc) {
    if (p.set.size === 0 && p.unset.size === 0) this.pending.delete(docKey(p.id));
  }

  /** The document with its staged edits applied. */
  effective(doc: EJson): EJson {
    const p = this.pending.get(docKey(idOf(doc)));
    if (!p) return doc;
    let out = doc;
    for (const { path, value } of p.set.values()) out = setAt(out, path, value);
    for (const path of p.unset.values()) out = setAt(out, path, undefined);
    return out;
  }

  /** Paths of `doc` that carry a staged edit, as stringified keys. */
  editedPaths(doc: EJson): Set<string> {
    const p = this.pending.get(docKey(idOf(doc)));
    const out = new Set<string>();
    if (!p) return out;
    for (const k of p.set.keys()) out.add(k);
    for (const k of p.unset.keys()) out.add(k);
    return out;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  discard(): void {
    this.pending.clear();
    this.touch();
  }

  /** Send the staged edits, one document at a time. Returns whether all of them were saved. */
  async save(): Promise<boolean> {
    if (this.pending.size === 0) return true;
    this.store.setState({ saving: true, saveError: null });
    try {
      for (const p of [...this.pending.values()]) {
        if (!(await this.saveOne(p))) {
          this.store.setState({ saving: false });
          return false;
        }
      }
      this.store.setState({ saving: false });
      return true;
    } catch (e) {
      this.store.setState({ saving: false, saveError: messageOf(e) });
      return false;
    }
  }

  private request(p: PendingDoc, force: boolean): DocRequest {
    const changed = [...[...p.set.values()].map((s) => s.path), ...p.unset.values()];
    const simple =
      changed.every(dottable) &&
      // $unset on an array element leaves null behind; replace the document instead
      [...p.unset.values()].every((path) => !Array.isArray(getAt(p.original, path.slice(0, -1))));
    if (simple) {
      const set: Record<string, EJson> = {};
      for (const { path, value } of p.set.values()) set[path.join(".")] = value;
      return {
        op: "update",
        database: this.database,
        collection: this.collection,
        id: p.id,
        set,
        unset: [...p.unset.values()].map((path) => path.join(".")),
        check: changed.map((path): FieldCheck => {
          const value = getAt(p.original, path);
          return value === undefined
            ? { path: path.join("."), absent: true, value: null }
            : { path: path.join("."), absent: false, value };
        }),
        force,
      };
    }
    const original = p.original as { [k: string]: EJson };
    return {
      op: "replace",
      database: this.database,
      collection: this.collection,
      id: p.id,
      document: this.effective(p.original),
      // replacing writes every field, so any field changing underneath is a conflict
      check: Object.keys(original).map((path) => ({ path, absent: false, value: original[path] })),
      force,
    };
  }

  private async saveOne(p: PendingDoc): Promise<boolean> {
    let force = false;
    for (;;) {
      const reply = await this.guarded(this.request(p, force));
      if (!reply) return false; // the user declined the confirmation
      if (reply.kind === "written") {
        const next = this.effective(p.original);
        this.pending.delete(docKey(p.id));
        this.store.setState((s) => ({
          docs: s.docs.map((d) => (docKey(idOf(d)) === docKey(p.id) ? next : d)),
          pendingVersion: s.pendingVersion + 1,
        }));
        return true;
      }
      if (reply.kind !== "conflict") throw new Error("Unexpected reply");
      const gone = reply.current === null;
      const choice = await askChoice({
        title: gone ? "This document was deleted" : "This document changed",
        body: gone
          ? "Someone removed it from the collection after you loaded it."
          : "Another change reached it after you loaded it, so saving would overwrite theirs.",
        choices: [
          { id: "reload", label: gone ? "Drop my edits" : "Reload" },
          ...(gone ? [] : [{ id: "overwrite", label: "Overwrite", variant: "primary" as const }]),
          { id: "cancel", label: "Cancel" },
        ],
      });
      if (choice === "overwrite") {
        force = true;
        continue;
      }
      if (choice === "reload") {
        this.pending.delete(docKey(p.id));
        this.store.setState((s) => ({
          docs: gone
            ? s.docs.filter((d) => docKey(idOf(d)) !== docKey(p.id))
            : s.docs.map((d) => (docKey(idOf(d)) === docKey(p.id) ? (reply.current as EJson) : d)),
          pendingVersion: s.pendingVersion + 1,
        }));
        return true;
      }
      return false;
    }
  }

  // ---- inserting and deleting ----------------------------------------------------------------------

  /** Evaluate shell-syntax text to a document. Throws the parse error. */
  async evaluate(text: string): Promise<EJson> {
    const reply = await this.call({ op: "evaluate", text });
    if (reply.kind !== "value") throw new Error("Unexpected reply");
    return reply.value as EJson;
  }

  async insert(documents: EJson[]): Promise<boolean> {
    const reply = await this.guarded({
      op: "insert",
      database: this.database,
      collection: this.collection,
      documents,
    });
    if (!reply) return false;
    if (this.lastQuery) await this.find(this.lastQuery);
    return true;
  }

  async deleteDocs(docs: EJson[]): Promise<boolean> {
    const ids = docs.map(idOf).filter((i): i is EJson => i !== undefined);
    const reply = await this.guarded({
      op: "delete",
      database: this.database,
      collection: this.collection,
      ids,
    });
    if (!reply) return false;
    const gone = new Set(ids.map(docKey));
    for (const k of gone) this.pending.delete(k);
    this.store.setState((s) => ({
      docs: s.docs.filter((d) => !gone.has(docKey(idOf(d)))),
      pendingVersion: s.pendingVersion + 1,
      matched: s.matched
        ? { ...s.matched, count: Math.max(0, s.matched.count - ids.length) }
        : null,
    }));
    return true;
  }

  // ---- schema and indexes ----------------------------------------------------------------------------

  async loadSchema(filter = ""): Promise<void> {
    this.store.setState({ schemaLoading: true, schemaError: null });
    try {
      const reply = await this.call({
        op: "schema",
        database: this.database,
        collection: this.collection,
        filter,
        sample: 1000,
      });
      if (reply.kind !== "schema") throw new Error("Unexpected reply");
      this.store.setState({
        schema: { sampled: reply.sampled, fields: reply.fields },
        schemaLoading: false,
      });
    } catch (e) {
      this.store.setState({ schemaLoading: false, schemaError: messageOf(e) });
    }
  }

  async loadIndexes(): Promise<void> {
    try {
      const reply = await this.call({
        op: "indexes",
        database: this.database,
        collection: this.collection,
      });
      if (reply.kind !== "indexes") throw new Error("Unexpected reply");
      this.store.setState({ indexes: reply.items, indexesError: null });
    } catch (e) {
      this.store.setState({ indexesError: messageOf(e) });
    }
  }

  async createIndex(spec: {
    keys: string;
    name: string | null;
    unique: boolean;
    sparse: boolean;
    ttlSeconds: number | null;
  }): Promise<boolean> {
    const reply = await this.guarded({
      op: "create_index",
      database: this.database,
      collection: this.collection,
      keys: spec.keys,
      name: spec.name,
      unique: spec.unique,
      sparse: spec.sparse,
      ttl_seconds: spec.ttlSeconds,
    });
    if (!reply) return false;
    if (reply.kind === "indexes") this.store.setState({ indexes: reply.items, indexesError: null });
    return true;
  }

  async dropIndex(name: string): Promise<boolean> {
    const reply = await this.guarded({
      op: "drop_index",
      database: this.database,
      collection: this.collection,
      name,
    });
    if (!reply) return false;
    if (reply.kind === "indexes") this.store.setState({ indexes: reply.items, indexesError: null });
    return true;
  }

  // ---- export -------------------------------------------------------------------------------------------

  async exportTo(
    path: string,
    format: ExportFormat,
    q: Pick<CollectionTabState, "filter" | "project" | "sort">,
  ): Promise<number> {
    const reply = await this.call({
      op: "export",
      database: this.database,
      collection: this.collection,
      filter: q.filter,
      projection: q.project,
      sort: q.sort,
      format,
      path,
    });
    if (reply.kind !== "exported") throw new Error("Unexpected reply");
    return reply.count;
  }

  close(): void {
    this.closed = true;
    this.runId += 1;
    const id = this.sessionId;
    this.pending.clear();
    this.store.setState({ ...INITIAL });
    if (id) void sessionClose(id).catch(() => {});
  }
}

const runtimes = new Map<string, CollectionRuntime>();

export function getCollectionRuntime(
  tabId: string,
  connectionId: string,
  database: string,
  collection: string,
): CollectionRuntime {
  let r = runtimes.get(tabId);
  if (!r) {
    r = new CollectionRuntime(tabId, connectionId, database, collection);
    runtimes.set(tabId, r);
  }
  return r;
}

export const peekCollectionRuntime = (tabId: string) => runtimes.get(tabId);

export function disposeCollectionRuntime(tabId: string): void {
  runtimes.get(tabId)?.close();
  runtimes.delete(tabId);
}

/** Test helper. */
export function clearCollectionRuntimes(): void {
  for (const r of runtimes.values()) r.close();
  runtimes.clear();
}
