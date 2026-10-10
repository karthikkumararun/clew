/**
 * What a console tab holds while the app runs but does not persist: its database session and
 * whatever is running on it. It lives outside React because only the active tab is mounted, and
 * a query must keep running (and its results keep arriving) while the user looks at another tab.
 */
import { createStore } from "zustand/vanilla";
import type { StoreApi } from "zustand/vanilla";
import { useConnections } from "../../connections/connectionsStore";
import { sessionSwitchNamespace } from "../../connections/api";
import { sessionClose, sessionOpen } from "../../lib/ipc/drivers";
import { useWorkspace } from "../../stores/workspaceStore";
import type { ConsoleState } from "./state";
import type { OpenedSession } from "../../lib/ipc/drivers";

export interface RuntimeState {
  sessionId: string | null;
  /** Opening the session (connecting first when needed). */
  opening: boolean;
  /** `via SSH <host>` etc., from the opened session. */
  transport: string | null;
  server: OpenedSession["server"] | null;
}

const INITIAL: RuntimeState = { sessionId: null, opening: false, transport: null, server: null };

export class ConsoleRuntime {
  readonly store: StoreApi<RuntimeState> = createStore<RuntimeState>(() => ({ ...INITIAL }));
  private opening: Promise<string> | null = null;
  private closed = false;

  constructor(
    readonly tabId: string,
    readonly connectionId: string,
  ) {}

  get sessionId(): string | null {
    return this.store.getState().sessionId;
  }

  /** The tab's own session, opened on first use. Connects the connection when it isn't. */
  ensureSession(): Promise<string> {
    const existing = this.sessionId;
    if (existing) return Promise.resolve(existing);
    if (this.opening) return this.opening;
    this.store.setState({ opening: true });
    const attempt = (async () => {
      const ok = await useConnections.getState().connect(this.connectionId);
      if (!ok) throw new Error("The connection isn't available");
      const opened = await sessionOpen(this.connectionId);
      if (this.closed) {
        void sessionClose(opened.sessionId).catch(() => {});
        throw new Error("The console was closed");
      }
      this.store.setState({
        sessionId: opened.sessionId,
        transport: opened.transport,
        server: opened.server,
      });
      this.mirror(opened.sessionId);
      // A database / schema picked on the connection chip before the first run.
      const { database, schema } = this.tabState() ?? {};
      if (database || schema) {
        try {
          await sessionSwitchNamespace(opened.sessionId, { database, schema });
        } catch {
          /* the console still works in the default namespace */
        }
      }
      return opened.sessionId;
    })();
    this.opening = attempt;
    const clear = () => {
      this.opening = null;
      this.store.setState({ opening: false });
    };
    attempt.then(clear, clear);
    return attempt;
  }

  private tabState(): ConsoleState | undefined {
    return useWorkspace.getState().tabs.find((t) => t.id === this.tabId)?.state as
      ConsoleState | undefined;
  }

  /** Publish the session id on the tab, where the connection chip looks for it. */
  private mirror(sessionId: string | undefined): void {
    if (this.tabState()) {
      useWorkspace.getState().updateTabState<Partial<ConsoleState>>(this.tabId, { sessionId });
    }
  }

  /** The connection dropped: the session is gone, a new one opens on the next run. */
  sessionLost(): void {
    this.store.setState({ ...INITIAL });
    this.mirror(undefined);
  }

  /** Close the tab's session (the tab was closed). */
  close(): void {
    this.closed = true;
    const id = this.sessionId;
    this.store.setState({ ...INITIAL });
    if (id) void sessionClose(id).catch(() => {});
  }
}

const runtimes = new Map<string, ConsoleRuntime>();

/** The runtime of a console tab, created on first use. */
export function getRuntime(tabId: string, connectionId: string): ConsoleRuntime {
  let r = runtimes.get(tabId);
  if (!r) {
    r = new ConsoleRuntime(tabId, connectionId);
    runtimes.set(tabId, r);
  }
  return r;
}

export function peekRuntime(tabId: string): ConsoleRuntime | undefined {
  return runtimes.get(tabId);
}

export function disposeRuntime(tabId: string): void {
  runtimes.get(tabId)?.close();
  runtimes.delete(tabId);
}

/** Test helper. */
export function clearRuntimes(): void {
  for (const r of runtimes.values()) r.close();
  runtimes.clear();
}
