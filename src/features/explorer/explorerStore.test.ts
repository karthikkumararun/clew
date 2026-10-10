import { useConnections } from "../../connections/connectionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import type { NodePath, TreeNode } from "../../lib/ipc/drivers";
import { resetUiState } from "../../lib/uiState";
import { startExplorerSync, useExplorer } from "./explorerStore";
import { conn, file, tn } from "./testing";
import { nodeId } from "./tree";

const api = vi.hoisted(() => ({ children: vi.fn() }));
vi.mock("../../lib/ipc/drivers", () => ({
  introspectChildren: (c: string, p: NodePath) => api.children(c, p),
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "message" in e,
}));

const DB: NodePath = [{ kind: "database", name: "analytics" }];
const SCHEMA: NodePath = [...DB, { kind: "schema", name: "public" }];
const TABLES: NodePath = [...SCHEMA, { kind: "group", name: "tables" }];

/** A small fixed tree: analytics › public › tables › orders › (id, user_id). */
function fixture(path: NodePath): TreeNode[] {
  const key = path.map((s) => s.name).join("/");
  switch (key) {
    case "":
      return [tn([], "database", "analytics"), tn([], "database", "billing")];
    case "analytics":
      return [tn(DB, "schema", "public")];
    case "analytics/public":
      return [tn(SCHEMA, "group", "tables", { detail: "2" })];
    case "analytics/public/tables":
      return [tn(TABLES, "table", "orders", { detail: "12.4k" }), tn(TABLES, "table", "users")];
    case "analytics/public/tables/orders":
      return [
        tn([...TABLES, { kind: "table", name: "orders" }], "column", "id"),
        tn([...TABLES, { kind: "table", name: "orders" }], "column", "user_id"),
      ];
    default:
      return [];
  }
}

const ID = {
  db: nodeId("c1", DB),
  schema: nodeId("c1", SCHEMA),
  tables: nodeId("c1", TABLES),
  orders: nodeId("c1", [...TABLES, { kind: "table", name: "orders" }]),
};

let stop: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  resetUiState();
  api.children.mockImplementation(async (_c: string, p: NodePath) => fixture(p));
  useExplorer.setState({
    nodes: {},
    expanded: new Set(),
    collapsedGroups: new Set(),
    selectedId: null,
    filter: "",
    counts: {},
  });
  useConnections.setState({
    file: file([conn("c1", "prod-postgres")]),
    connected: {},
    busy: {},
    connect: vi.fn(async (id: string) => {
      useConnections.setState((s) => ({ connected: { ...s.connected, [id]: {} as never } }));
      return true;
    }),
  });
  stop = startExplorerSync();
});

afterEach(() => stop());

describe("lazy expansion", () => {
  it("connects first, then loads the databases, and only the expanded levels", async () => {
    await useExplorer.getState().toggle("c1");
    expect(useConnections.getState().connect).toHaveBeenCalledWith("c1");
    expect(api.children).toHaveBeenCalledTimes(1);
    expect(api.children).toHaveBeenCalledWith("c1", []);
    const { nodes } = useExplorer.getState();
    expect(nodes.c1.childIds).toEqual([
      ID.db,
      nodeId("c1", [{ kind: "database", name: "billing" }]),
    ]);
    expect(nodes[ID.db].state).toBe("idle"); // not loaded until expanded
  });

  it("expands and collapses a node without reloading it", async () => {
    await useExplorer.getState().toggle("c1");
    await useExplorer.getState().toggle(ID.db);
    expect(useExplorer.getState().expanded.has(ID.db)).toBe(true);
    useExplorer.getState().collapse(ID.db);
    await useExplorer.getState().toggle(ID.db);
    expect(
      (api.children.mock.calls as [string, NodePath][]).filter(([, p]) => p.length === 1),
    ).toHaveLength(1);
  });

  it("stays collapsed when the connection can't be made", async () => {
    useConnections.setState({ connect: vi.fn(async () => false) });
    await useExplorer.getState().toggle("c1");
    expect(useExplorer.getState().expanded.has("c1")).toBe(false);
    expect(api.children).not.toHaveBeenCalled();
  });

  it("coalesces concurrent loads of one node into one request", async () => {
    await useExplorer.getState().toggle("c1");
    await Promise.all([useExplorer.getState().load(ID.db), useExplorer.getState().load(ID.db)]);
    expect(
      (api.children.mock.calls as [string, NodePath][]).filter(([, p]) => p.length === 1),
    ).toHaveLength(1);
  });
});

describe("errors", () => {
  it("isolates a failure to its node and retries", async () => {
    await useExplorer.getState().toggle("c1");
    api.children.mockRejectedValueOnce({ code: "driver", message: "permission denied" });
    await useExplorer.getState().toggle(ID.db);
    let { nodes } = useExplorer.getState();
    expect(nodes[ID.db].state).toBe("error");
    expect(nodes[ID.db].error).toBe("permission denied");
    expect(nodes.c1.state).toBe("loaded"); // siblings and parents are untouched
    await useExplorer.getState().load(ID.db); // Retry
    nodes = useExplorer.getState().nodes;
    expect(nodes[ID.db].state).toBe("loaded");
    expect(nodes[ID.db].error).toBeUndefined();
  });
});

describe("refresh", () => {
  it("reloads the subtree and keeps expanded children expanded", async () => {
    const ex = useExplorer.getState();
    await ex.toggle("c1");
    for (const id of [ID.db, ID.schema, ID.tables, ID.orders]) await ex.toggle(id);
    expect(useExplorer.getState().nodes[ID.orders].childIds).toHaveLength(2);
    api.children.mockClear();

    await ex.refresh(ID.schema);
    const paths = (api.children.mock.calls as [string, NodePath][]).map(([, p]) => p.length);
    expect(paths).toEqual([2, 3, 4]); // schema, tables group, orders // schema down to orders
    const { nodes, expanded } = useExplorer.getState();
    expect(expanded.has(ID.tables) && expanded.has(ID.orders)).toBe(true);
    expect(nodes[ID.orders].childIds).toHaveLength(2);
  });

  it("drops children that no longer exist", async () => {
    const ex = useExplorer.getState();
    await ex.toggle("c1");
    for (const id of [ID.db, ID.schema, ID.tables]) await ex.toggle(id);
    const users = nodeId("c1", [...TABLES, { kind: "table", name: "users" }]);
    expect(useExplorer.getState().nodes[users]).toBeDefined();
    api.children.mockImplementation(async (_c: string, p: NodePath) =>
      p.length === 3 ? [tn(TABLES, "table", "orders")] : fixture(p),
    );
    await ex.refresh(ID.tables);
    expect(useExplorer.getState().nodes[users]).toBeUndefined();
  });

  it("discards the answer of a request that a refresh replaced", async () => {
    await useExplorer.getState().toggle("c1");
    let release: (v: TreeNode[]) => void = () => {};
    api.children.mockImplementationOnce(() => new Promise<TreeNode[]>((r) => (release = r)));
    const slow = useExplorer.getState().toggle(ID.db);
    await Promise.resolve();
    await useExplorer.getState().refresh(ID.db); // answers from the fixture
    release([tn(DB, "schema", "stale")]);
    await slow;
    const names = useExplorer.getState().nodes[ID.db].childIds;
    expect(names).toEqual([ID.schema]);
  });
});

describe("persisted state and connection sync", () => {
  it("restores an expanded path when the connection next connects", async () => {
    const expanded = new Set(["c1", ID.db, ID.schema, ID.tables]);
    useExplorer.setState({ expanded });
    // Nothing connects on its own.
    expect(api.children).not.toHaveBeenCalled();
    await useConnections.getState().connect("c1");
    await vi.waitFor(() => expect(useExplorer.getState().nodes[ID.tables]?.state).toBe("loaded"));
    expect(useExplorer.getState().nodes[ID.tables].childIds).toHaveLength(2);
  });

  it("forgets loaded nodes on disconnect but keeps what was expanded", async () => {
    await useExplorer.getState().toggle("c1");
    useConnections.setState({ connected: {} });
    expect(useExplorer.getState().nodes.c1).toBeUndefined();
    expect(useExplorer.getState().expanded.has("c1")).toBe(true);
  });

  it("persists expansion, selection and collapsed groups, and rehydrates them", async () => {
    await useExplorer.getState().toggle("c1");
    useExplorer.getState().select(ID.db);
    useExplorer.getState().toggleGroup("g1");
    useExplorer.setState({ expanded: new Set(), collapsedGroups: new Set(), selectedId: null });
    useExplorer.getState().rehydrate();
    const s = useExplorer.getState();
    expect(s.expanded.has("c1")).toBe(true);
    expect(s.selectedId).toBe(ID.db);
    expect(s.collapsedGroups.has("g1")).toBe(true);
  });
});

describe("restart and tab sync", () => {
  it("restores the expanded path after a simulated restart, only once the connection connects", async () => {
    const ex = useExplorer.getState();
    await ex.toggle("c1");
    for (const id of [ID.db, ID.schema, ID.tables]) await ex.toggle(id);
    ex.select(ID.tables);

    // Restart: everything in memory is gone, only the persisted state remains.
    stop();
    useConnections.setState({ connected: {} });
    useExplorer.setState({ nodes: {}, expanded: new Set(), selectedId: null });
    api.children.mockClear();
    useExplorer.getState().rehydrate();
    stop = startExplorerSync();
    expect(api.children).not.toHaveBeenCalled(); // no automatic connecting

    await useConnections.getState().connect("c1");
    await vi.waitFor(() => expect(useExplorer.getState().nodes[ID.tables]?.state).toBe("loaded"));
    expect(useExplorer.getState().selectedId).toBe(ID.tables);
  });

  it("reveals and selects a table when its editor tab becomes active", async () => {
    useConnections.setState({ connected: { c1: {} as never } });
    const path: NodePath = [...TABLES, { kind: "table", name: "orders" }];
    useWorkspace.setState({
      tabs: [{ id: "t1", kind: "table", key: "k", state: { connectionId: "c1", path } }],
      activeTabId: null,
    });
    useWorkspace.getState().activateTab("t1");
    await vi.waitFor(() => expect(useExplorer.getState().selectedId).toBe(ID.orders));
    const { expanded } = useExplorer.getState();
    expect([...expanded]).toEqual(expect.arrayContaining(["c1", ID.db, ID.schema, ID.tables]));
  });

  it("ignores tabs that aren't table editors", async () => {
    useConnections.setState({ connected: { c1: {} as never } });
    useWorkspace.setState({
      tabs: [{ id: "t2", kind: "console", key: "k2", state: { connectionId: "c1" } }],
      activeTabId: null,
    });
    useWorkspace.getState().activateTab("t2");
    await Promise.resolve();
    expect(useExplorer.getState().selectedId).toBeNull();
  });
});
