import { create } from "zustand";
import { useConnections } from "../../connections/connectionsStore";
import { introspectChildren, isAppError } from "../../lib/ipc/drivers";
import type { TreeNode } from "../../lib/ipc/drivers";
import { getUiState, setUiState } from "../../lib/uiState";
import { useWorkspace } from "../../stores/workspaceStore";
import type { NodePath } from "../../lib/ipc/drivers";
import { connOfId, nodeId, rootEntry } from "./tree";
import type { NodeEntry } from "./tree";

const KEY_EXPANDED = "explorer.expanded";
const KEY_SELECTED = "explorer.selected";
const KEY_GROUPS = "explorer.collapsedGroups";

function readSet(key: string): Set<string> {
  try {
    const raw = getUiState(key);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

const writeSet = (key: string, set: ReadonlySet<string>) =>
  setUiState(key, JSON.stringify([...set]));

interface ExplorerState {
  nodes: Record<string, NodeEntry>;
  /** Expanded node ids, including those under disconnected connections. */
  expanded: Set<string>;
  collapsedGroups: Set<string>;
  selectedId: string | null;
  filter: string;
  /** Exact row counts fetched with "Count rows", keyed by node id. */
  counts: Record<string, number>;

  /** Re-read persisted state (after `hydrateUiState`). */
  rehydrate: () => void;
  setFilter: (filter: string) => void;
  select: (id: string | null) => void;
  toggleGroup: (key: string) => void;
  collapseAll: () => void;
  /** Expand a node, connecting first when it is a disconnected connection. */
  expand: (id: string) => Promise<void>;
  collapse: (id: string) => void;
  toggle: (id: string) => Promise<void>;
  /** Load a node's children; resolves when it and any restored expanded descendants are loaded. */
  load: (id: string) => Promise<void>;
  /** Reload a subtree, keeping expanded children expanded. */
  refresh: (id: string) => Promise<void>;
  /** Forget everything loaded for a connection (it disconnected or was deleted). */
  drop: (connId: string) => void;
  /** Expand the ancestors of `id` so its row is visible, loading what is needed. */
  reveal: (id: string) => Promise<void>;
  setCount: (id: string, count: number) => void;
}

/** One in-flight request per node, and a generation so a refresh replaces a stale answer. */
const inflight = new Map<string, Promise<void>>();
const generation = new Map<string, number>();

export const useExplorer = create<ExplorerState>((set, get) => {
  const patchEntry = (id: string, patch: Partial<NodeEntry>) =>
    set((s) => {
      const e = s.nodes[id];
      return e ? { nodes: { ...s.nodes, [id]: { ...e, ...patch } } } : s;
    });

  const removeSubtree = (nodes: Record<string, NodeEntry>, ids: string[]) => {
    const stack = [...ids];
    while (stack.length) {
      const id = stack.pop() as string;
      const e = nodes[id];
      if (!e) continue;
      stack.push(...e.childIds);
      delete nodes[id];
    }
  };

  const toEntry = (connId: string, parentId: string, n: TreeNode): NodeEntry => ({
    id: nodeId(connId, n.path),
    connId,
    parentId,
    kind: n.kind,
    name: n.name,
    path: n.path,
    detail: n.detail ?? undefined,
    hasChildren: n.has_children,
    column: n.column ?? undefined,
    childIds: [],
    state: "idle",
  });

  async function fetchChildren(id: string): Promise<void> {
    const entry = get().nodes[id];
    if (!entry) return;
    const gen = (generation.get(id) ?? 0) + 1;
    generation.set(id, gen);
    patchEntry(id, { state: "loading", error: undefined });
    try {
      const children = await introspectChildren(entry.connId, entry.path);
      if (generation.get(id) !== gen) return; // a newer request owns this node
      const fresh = children.map((n) => toEntry(entry.connId, id, n));
      set((s) => {
        const nodes = { ...s.nodes };
        const old = nodes[id];
        if (!old) return s;
        const keep = new Set(fresh.map((f) => f.id));
        removeSubtree(
          nodes,
          old.childIds.filter((c) => !keep.has(c)),
        );
        for (const f of fresh) {
          // A child that survived a refresh keeps what it already loaded.
          const prev = nodes[f.id];
          nodes[f.id] = prev ? { ...f, childIds: prev.childIds, state: prev.state } : f;
        }
        nodes[id] = { ...old, childIds: fresh.map((f) => f.id), state: "loaded", error: undefined };
        return { nodes };
      });
    } catch (e) {
      if (generation.get(id) !== gen) return;
      patchEntry(id, {
        state: "error",
        error: isAppError(e) ? e.message : String(e),
      });
      return;
    }
    // Restore or keep expanded descendants (restart restore, and refresh).
    const { expanded, nodes } = get();
    const kids = (nodes[id]?.childIds ?? []).filter(
      (c) => expanded.has(c) && nodes[c]?.hasChildren,
    );
    await Promise.all(kids.map((c) => get().load(c)));
  }

  return {
    nodes: {},
    expanded: new Set(),
    collapsedGroups: new Set(),
    selectedId: null,
    filter: "",
    counts: {},

    rehydrate: () =>
      set({
        expanded: readSet(KEY_EXPANDED),
        collapsedGroups: readSet(KEY_GROUPS),
        selectedId: getUiState(KEY_SELECTED) || null,
      }),

    setFilter: (filter) => set({ filter }),

    select: (id) => {
      set({ selectedId: id });
      setUiState(KEY_SELECTED, id ?? "");
    },

    toggleGroup: (key) => {
      const next = new Set(get().collapsedGroups);
      if (!next.delete(key)) next.add(key);
      set({ collapsedGroups: next });
      writeSet(KEY_GROUPS, next);
    },

    collapseAll: () => {
      const next = new Set<string>();
      set({ expanded: next });
      writeSet(KEY_EXPANDED, next);
    },

    collapse: (id) => {
      const next = new Set(get().expanded);
      if (!next.delete(id)) return;
      set({ expanded: next });
      writeSet(KEY_EXPANDED, next);
    },

    expand: async (id) => {
      const next = new Set(get().expanded);
      next.add(id);
      set({ expanded: next });
      writeSet(KEY_EXPANDED, next);
      if (!id.includes("/")) {
        // A connection: connect first (prompting for a password if needed).
        const ok = await useConnections.getState().connect(id);
        if (!ok) {
          // Not connected: leave it collapsed rather than remembering a failed expand.
          get().collapse(id);
          return;
        }
        if (!get().nodes[id]) set((s) => ({ nodes: { ...s.nodes, [id]: rootEntry(id) } }));
      }
      const e = get().nodes[id];
      if (e && (e.state === "idle" || e.state === "error")) await get().load(id);
    },

    toggle: async (id) => {
      if (get().expanded.has(id)) get().collapse(id);
      else await get().expand(id);
    },

    load: (id) => {
      const running = inflight.get(id);
      if (running) return running;
      if (!get().nodes[id] && !id.includes("/")) {
        set((s) => ({ nodes: { ...s.nodes, [id]: rootEntry(id) } }));
      }
      const p: Promise<void> = fetchChildren(id).finally(() => {
        if (inflight.get(id) === p) inflight.delete(id);
      });
      inflight.set(id, p);
      return p;
    },

    refresh: async (id) => {
      inflight.delete(id); // replaced: the older answer is discarded by its generation
      if (!get().nodes[id]) return;
      await get().load(id);
    },

    drop: (connId) => {
      set((s) => {
        const nodes = { ...s.nodes };
        for (const k of Object.keys(nodes)) if (nodes[k].connId === connId) delete nodes[k];
        const counts = { ...s.counts };
        for (const k of Object.keys(counts)) if (connOfId(k) === connId) delete counts[k];
        return { nodes, counts };
      });
      for (const k of [...inflight.keys()]) if (connOfId(k) === connId) inflight.delete(k);
      for (const k of [...generation.keys()]) {
        if (connOfId(k) === connId) generation.set(k, (generation.get(k) ?? 0) + 1);
      }
    },

    reveal: async (id) => {
      // Expand every ancestor, outermost first, loading what isn't loaded yet.
      const parts = id.split("/");
      const next = new Set(get().expanded);
      const ancestors: string[] = [];
      for (let i = 1; i < parts.length; i++) ancestors.push(parts.slice(0, i).join("/"));
      for (const a of ancestors) next.add(a);
      set({ expanded: next });
      writeSet(KEY_EXPANDED, next);
      for (const a of ancestors) {
        const e = get().nodes[a];
        if (!e && a.includes("/")) return; // the parent didn't list it: nothing to reveal
        if (!e || e.state === "idle" || e.state === "error") await get().load(a);
      }
      if (get().nodes[id]) get().select(id);
    },

    setCount: (id, count) => set((s) => ({ counts: { ...s.counts, [id]: count } })),
  };
});

/**
 * Keep the tree in step with connections: load an expanded connection's tree as soon as it
 * connects (restoring the expanded path), and forget the tree when it disconnects or is deleted.
 */
/**
 * The state a table editor tab carries so the explorer can find its node (`add-data-grid`
 * follows this): the owning connection and the table's introspection path.
 */
export interface TableTabState {
  connectionId: string;
  path: NodePath;
}

function tableOf(state: unknown): TableTabState | null {
  const s = state as Partial<TableTabState> | null;
  return s && typeof s.connectionId === "string" && Array.isArray(s.path)
    ? { connectionId: s.connectionId, path: s.path }
    : null;
}

export function startExplorerSync(): () => void {
  const loadIfNeeded = (id: string) => {
    const ex = useExplorer.getState();
    if (ex.expanded.has(id) && !ex.nodes[id]) void ex.load(id);
  };
  // Switching to a table editor reveals and highlights its table.
  const offTabs = useWorkspace.subscribe((state, prev) => {
    if (state.activeTabId === prev.activeTabId) return;
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (!tab || tab.kind !== "table") return;
    const t = tableOf(tab.state);
    if (t) void useExplorer.getState().reveal(nodeId(t.connectionId, t.path));
  });
  const offConnections = useConnections.subscribe((state, prev) => {
    for (const id of Object.keys(state.connected)) {
      if (!prev.connected[id]) loadIfNeeded(id);
    }
    for (const id of Object.keys(prev.connected)) {
      if (!state.connected[id]) useExplorer.getState().drop(id);
    }
    if (state.file !== prev.file) {
      const alive = new Set(state.file.connections.map((c) => c.id));
      for (const c of prev.file.connections)
        if (!alive.has(c.id)) useExplorer.getState().drop(c.id);
    }
  });
  return () => {
    offTabs();
    offConnections();
  };
}
