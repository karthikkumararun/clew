/**
 * What a key-browser tab holds while the app runs: its Redis session, the keys scanned so far,
 * and the open key's details and contents. Lives outside React like the other tab runtimes.
 */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { useConnections } from "../../connections/connectionsStore";
import { sessionClose, sessionOpen } from "../../lib/ipc/drivers";
import { useWorkspace } from "../../stores/workspaceStore";
import { confirmGuarded } from "../safety/confirm";
import { sessionReadOnly, setSessionReadOnly } from "../safety/ipc";
import { kvCall, kvSafetyCheck } from "./api";
import { quote } from "./format";
import type { KeyDetail, KeyInfo, RedisValue } from "./api";
import type { KeysTabState } from "./state";

/** Keys asked of the server per SCAN step. */
export const SCAN_COUNT = 1000;
/** Elements read per chunk of a list, hash, set, sorted set or stream. */
export const CHUNK = 500;

export interface PageState {
  rows: RedisValue[][];
  next: string | null;
  total: number | null;
  loading: boolean;
  error: string | null;
}

export interface KeysRuntimeState {
  sessionId: string | null;
  readOnly: boolean;
  /** Keys per logical database that has any, and how many databases the server has. */
  databases: { items: [number, number][]; count: number } | null;
  keys: KeyInfo[];
  /** `"0"` once the scan has covered the keyspace. */
  cursor: string;
  scanning: boolean;
  /** The first SCAN step has come back. */
  scanned: boolean;
  listError: string | null;
  detail: KeyDetail | null;
  /** The selected key no longer exists. */
  missing: boolean;
  detailLoading: boolean;
  detailError: string | null;
  page: PageState;
  /** The last edit failed: why. */
  editError: string | null;
}

const EMPTY_PAGE: PageState = { rows: [], next: null, total: null, loading: false, error: null };

const INITIAL: KeysRuntimeState = {
  sessionId: null,
  readOnly: false,
  databases: null,
  keys: [],
  cursor: "0",
  scanning: false,
  scanned: false,
  listError: null,
  detail: null,
  missing: false,
  detailLoading: false,
  detailError: null,
  page: EMPTY_PAGE,
  editError: null,
};

export const messageOf = (e: unknown) =>
  typeof e === "object" && e !== null && "message" in e
    ? String((e as { message: unknown }).message)
    : String(e);

export class KeysRuntime {
  readonly store: StoreApi<KeysRuntimeState> = createStore<KeysRuntimeState>(() => ({
    ...INITIAL,
  }));
  private opening: Promise<string> | null = null;
  private closed = false;
  private scanId = 0;
  private openId = 0;
  private scanKey: string | null = null;

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
        throw new Error("The key browser was closed");
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
          .updateTabState<Partial<KeysTabState>>(this.tabId, { sessionId: opened.sessionId });
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
      this.store.setState({ editError: messageOf(e) });
    }
  }

  async loadDatabases(): Promise<void> {
    try {
      const sessionId = await this.ensureSession();
      const r = await kvCall(sessionId, { op: "databases" });
      if (r.kind === "databases") {
        this.store.setState({ databases: { items: r.items, count: r.databases } });
      }
    } catch {
      /* the picker falls back to 16 databases */
    }
  }

  /** Scan from the start for `pattern` in `db`, unless that is what's already listed. */
  async scanIfNeeded(db: number, pattern: string): Promise<void> {
    if (this.scanKey === JSON.stringify([db, pattern]) && this.store.getState().scanned) return;
    await this.scan(db, pattern);
  }

  /** One SCAN step from the start. */
  async scan(db: number, pattern: string): Promise<void> {
    const id = ++this.scanId;
    this.scanKey = JSON.stringify([db, pattern]);
    this.store.setState({
      keys: [],
      cursor: "0",
      scanning: true,
      scanned: false,
      listError: null,
    });
    await this.step(id, db, pattern, "");
  }

  /** "Load more": continue the cursor. */
  async more(db: number, pattern: string): Promise<void> {
    const { cursor, scanning } = this.store.getState();
    if (scanning || cursor === "0") return;
    const id = ++this.scanId;
    this.store.setState({ scanning: true });
    await this.step(id, db, pattern, cursor);
  }

  private async step(id: number, db: number, pattern: string, cursor: string) {
    try {
      const sessionId = await this.ensureSession();
      const r = await kvCall(sessionId, {
        op: "scan",
        db,
        pattern,
        cursor,
        count: SCAN_COUNT,
        type_filter: null,
      });
      if (id !== this.scanId) return;
      if (r.kind !== "keys") throw new Error("Unexpected reply");
      this.store.setState((s) => {
        const seen = new Set(s.keys.map((k) => k.name));
        // SCAN may return a key more than once
        const fresh = r.keys.filter((k) => !seen.has(k.name));
        return { keys: [...s.keys, ...fresh], cursor: r.cursor, scanning: false, scanned: true };
      });
    } catch (e) {
      if (id !== this.scanId) return;
      this.store.setState({ scanning: false, scanned: true, listError: messageOf(e) });
    }
  }

  // ---- the open key --------------------------------------------------------------------------------

  /** Load details and the first chunk of `key`. */
  async open(db: number, key: string): Promise<void> {
    const id = ++this.openId;
    this.store.setState({
      detail: null,
      missing: false,
      detailLoading: true,
      detailError: null,
      page: { ...EMPTY_PAGE, loading: true },
      editError: null,
    });
    try {
      const sessionId = await this.ensureSession();
      const r = await kvCall(sessionId, { op: "inspect", db, key });
      if (id !== this.openId) return;
      if (r.kind !== "key") throw new Error("Unexpected reply");
      if (!r.detail) {
        this.store.setState({ missing: true, detailLoading: false, page: EMPTY_PAGE });
        return;
      }
      this.store.setState({ detail: r.detail, detailLoading: false });
      await this.loadPage(db, r.detail, "", true, id);
    } catch (e) {
      if (id !== this.openId) return;
      this.store.setState({
        detailLoading: false,
        detailError: messageOf(e),
        page: EMPTY_PAGE,
      });
    }
  }

  close_key(): void {
    this.openId += 1;
    this.store.setState({ detail: null, missing: false, page: EMPTY_PAGE, editError: null });
  }

  /** Read the next chunk of the open key ("Load more"). */
  async nextPage(db: number): Promise<void> {
    const { detail, page } = this.store.getState();
    if (!detail || page.next === null || page.loading) return;
    await this.loadPage(db, detail, page.next, false, this.openId);
  }

  private async loadPage(
    db: number,
    detail: KeyDetail,
    position: string,
    first: boolean,
    id: number,
  ) {
    this.store.setState((s) => ({ page: { ...s.page, loading: true, error: null } }));
    try {
      const sessionId = await this.ensureSession();
      const r = await kvCall(sessionId, {
        op: "page",
        db,
        key: detail.name,
        type_name: detail.type_name,
        position,
        count: CHUNK,
      });
      if (id !== this.openId) return;
      if (r.kind !== "page") throw new Error("Unexpected reply");
      this.store.setState((s) => ({
        page: {
          rows: first ? r.rows : [...s.page.rows, ...r.rows],
          next: r.next,
          total: r.total,
          loading: false,
          error: null,
        },
      }));
    } catch (e) {
      if (id !== this.openId) return;
      this.store.setState((s) => ({ page: { ...s.page, loading: false, error: messageOf(e) } }));
    }
  }

  // ---- editing -------------------------------------------------------------------------------------------

  /**
   * Run a write: ask the safeguards, confirm when they say so, send it with their token.
   * Resolves false when the user declined.
   */
  async write(db: number, commandLine: string): Promise<boolean> {
    const sessionId = await this.ensureSession();
    const report = await kvSafetyCheck(sessionId, commandLine);
    if (report.decision === "block") {
      throw { code: "read_only", message: report.reason ?? "This session is read-only" };
    }
    let token: string | undefined;
    if (report.decision === "confirm" || report.decision === "typed_confirm") {
      if (!(await confirmGuarded(report))) return false;
      token = report.token;
    }
    const r = await kvCall(sessionId, { op: "command", db, line: commandLine }, token);
    if (r.kind === "reply" && r.value.kind === "error") {
      throw new Error(r.value.message);
    }
    return true;
  }

  /** Run edits in order, then reload the open key. Errors show under the viewer. */
  async edit(db: number, key: string, ...lines: string[]): Promise<boolean> {
    this.store.setState({ editError: null });
    try {
      for (const l of lines) {
        if (!(await this.write(db, l))) return false;
      }
    } catch (e) {
      this.store.setState({ editError: messageOf(e) });
      return false;
    }
    await this.open(db, key);
    this.patchListed(key);
    return true;
  }

  /** The open key's type or TTL may have changed: refresh its row in the list. */
  private patchListed(key: string) {
    const { detail } = this.store.getState();
    if (!detail || detail.name !== key) return;
    this.store.setState((s) => ({
      keys: s.keys.map((k) =>
        k.name === key ? { ...k, type_name: detail.type_name, ttl_ms: detail.ttl_ms } : k,
      ),
    }));
  }

  /** Delete the key and drop it from the list. */
  async deleteKey(db: number, key: string): Promise<boolean> {
    this.store.setState({ editError: null });
    try {
      if (!(await this.write(db, `DEL ${quote(key)}`))) return false;
    } catch (e) {
      this.store.setState({ editError: messageOf(e) });
      return false;
    }
    this.openId += 1;
    this.store.setState((s) => ({
      keys: s.keys.filter((k) => k.name !== key),
      detail: null,
      page: EMPTY_PAGE,
    }));
    return true;
  }

  async renameKey(db: number, key: string, to: string): Promise<boolean> {
    this.store.setState({ editError: null });
    try {
      if (!(await this.write(db, `RENAMENX ${quote(key)} ${quote(to)}`))) {
        return false;
      }
    } catch (e) {
      this.store.setState({ editError: messageOf(e) });
      return false;
    }
    this.store.setState((s) => ({
      keys: s.keys.map((k) => (k.name === key ? { ...k, name: to } : k)),
    }));
    await this.open(db, to);
    return true;
  }

  close(): void {
    this.closed = true;
    this.scanId += 1;
    this.openId += 1;
    const id = this.sessionId;
    this.store.setState({ ...INITIAL });
    if (id) void sessionClose(id).catch(() => {});
  }
}

const runtimes = new Map<string, KeysRuntime>();

export function getKeysRuntime(tabId: string, connectionId: string): KeysRuntime {
  let r = runtimes.get(tabId);
  if (!r) {
    r = new KeysRuntime(tabId, connectionId);
    runtimes.set(tabId, r);
  }
  return r;
}

export function disposeKeysRuntime(tabId: string): void {
  runtimes.get(tabId)?.close();
  runtimes.delete(tabId);
}

/** Test helper. */
export function clearKeysRuntimes(): void {
  for (const r of runtimes.values()) r.close();
  runtimes.clear();
}
