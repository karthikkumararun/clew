import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useConnections } from "../../connections/connectionsStore";
import { resetUiState } from "../../lib/uiState";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, registerCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { useNotices } from "../../stores/noticesStore";
import { registerExplorerCommands } from "./commands";
import { ExplorerPanel } from "./ExplorerPanel";
import { useExplorer } from "./explorerStore";
import { SAMPLE, conn, file, seedNodes, stubLayout } from "./testing";

const api = vi.hoisted(() => ({ move: vi.fn(), children: vi.fn(), ddl: vi.fn(), count: vi.fn() }));
vi.mock("../../lib/ipc/drivers", () => ({
  introspectChildren: (...a: unknown[]) => api.children(...a),
  introspectDdl: (...a: unknown[]) => api.ddl(...a),
  isAppError: () => false,
}));
vi.mock("./api", () => ({ explorerCountRows: (...a: unknown[]) => api.count(...a) }));

const prod = conn("c1", "prod-postgres", { environment: "production", groupId: "g1" });
const dev = conn("c2", "dev-mongo", { driver: "mongodb", environment: "local" });
const GROUPS = [
  { id: "g1", name: "Production", order: 0 },
  { id: "g2", name: "Staging", order: 1 },
];

const ids = (...path: string[]) => ["c1", ...path].join("/");
const DB = ids("database:analytics");
const SCHEMA = ids("database:analytics", "schema:public");
const TABLES = ids("database:analytics", "schema:public", "group:tables");
const ORDERS = ids("database:analytics", "schema:public", "group:tables", "table:orders");

let restore: () => void = () => {};
const calls: Record<string, unknown[]> = {};
const record = (id: string) =>
  registerCommand({
    id,
    title: id,
    category: "Test",
    run: (arg) => {
      (calls[id] ??= []).push(arg);
    },
  });

function seed(opts: { expandAll?: boolean; selected?: string | null } = {}) {
  const { nodes, expandable } = seedNodes("c1", SAMPLE);
  useConnections.setState({
    file: file([prod, dev], GROUPS),
    connected: { c1: {} as never },
    move: api.move,
  });
  useExplorer.setState({
    nodes,
    expanded: new Set(opts.expandAll === false ? [] : expandable),
    collapsedGroups: new Set(),
    selectedId: opts.selected ?? null,
    filter: "",
    counts: {},
  });
}

const row = (name: string | RegExp) => screen.getByRole("treeitem", { name });
const tree = () => screen.getByRole("tree", { name: "Database explorer" });

beforeEach(() => {
  vi.clearAllMocks();
  resetUiState();
  clearShortcuts();
  clearCommands();
  setPlatformForTests("mac");
  for (const k of Object.keys(calls)) delete calls[k];
  useNotices.setState({ notices: [] });
  restore = stubLayout();
  seed();
  registerExplorerCommands();
});
afterEach(() => restore());

describe("rendering", () => {
  it("shows groups, connections, databases, schemas, groups with counts, tables and columns", () => {
    render(<ExplorerPanel />);
    const labels = screen.getAllByRole("treeitem").map((r) => r.textContent);
    expect(labels).toEqual([
      "Production",
      expect.stringContaining("prod-postgres"),
      "analytics",
      "public",
      "tables3",
      "orders12.4k",
      "idint8",
      "user_idint8 → users",
      "statusorder_status",
      "order_items98k",
      "users1.2k",
      "views3",
      "billing",
      "Staging",
      "Ungrouped",
      expect.stringContaining("dev-mongo"),
    ]);
    expect(row(/prod-postgres/)).toHaveTextContent("PG");
    expect(
      within(row(/prod-postgres/)).getByRole("img", { name: "Connected" }),
    ).toBeInTheDocument();
    expect(row(/dev-mongo/)).toHaveTextContent("disconnected");
  });

  it("exposes ARIA tree semantics: levels, expanded state, selection", () => {
    seed({ selected: ORDERS });
    render(<ExplorerPanel />);
    expect(row("analytics")).toHaveAttribute("aria-level", "3");
    expect(row("analytics")).toHaveAttribute("aria-expanded", "true");
    expect(row(/^order_items/)).not.toHaveAttribute("aria-expanded", "true");
    expect(row(/^orders/)).toHaveAttribute("aria-selected", "true");
    expect(tree()).toHaveAttribute("aria-activedescendant", expect.stringMatching(/^ex-row-\d+$/));
  });

  it("uses a key icon for primary keys, a link icon for foreign keys and a count override", () => {
    const { container } = render(<ExplorerPanel />);
    expect(row(/^id/).querySelector("svg")).not.toBeNull(); // key icon
    const orders = row(/^orders/);
    act(() => useExplorer.getState().setCount(ORDERS, 12480));
    expect(orders).toHaveTextContent("12.5k");
    expect(container.querySelector('[title="12,480 rows · exact"]')).not.toBeNull();
  });

  it("shows the empty state with New connection and Import", () => {
    useConnections.setState({ file: file([]) });
    render(<ExplorerPanel />);
    expect(screen.getByText("No connections yet.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "New connection" })).toHaveLength(2); // header + body
    expect(screen.getByRole("button", { name: "Import…" })).toBeInTheDocument();
  });

  it("shows a loading indicator on the loading row only", () => {
    useExplorer.setState((s) => ({
      nodes: { ...s.nodes, [DB]: { ...s.nodes[DB], state: "loading" } },
    }));
    render(<ExplorerPanel />);
    expect(within(row(/^analytics/)).getByRole("img", { name: "Loading" })).toBeInTheDocument();
    expect(within(row("public")).queryByRole("img", { name: "Loading" })).toBeNull();
  });

  it("shows a red error row with Retry that reloads only that node", () => {
    api.children.mockResolvedValue([]);
    useExplorer.setState((s) => ({
      nodes: {
        ...s.nodes,
        [TABLES]: { ...s.nodes[TABLES], state: "error", error: "permission denied" },
      },
    }));
    render(<ExplorerPanel />);
    expect(screen.getByRole("alert")).toHaveTextContent("permission denied");
    expect(row("billing")).toBeInTheDocument(); // siblings unaffected
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(api.children).toHaveBeenCalledWith(
      "c1",
      expect.arrayContaining([{ kind: "group", name: "tables" }]),
    );
  });
});

describe("collapse and expand", () => {
  it("collapses a group header and Collapse all clears expansion", () => {
    render(<ExplorerPanel />);
    fireEvent.click(row("Production"));
    expect(screen.queryByRole("treeitem", { name: /prod-postgres/ })).toBeNull();
    fireEvent.click(row("Production"));
    fireEvent.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(useExplorer.getState().expanded.size).toBe(0);
    expect(screen.queryByRole("treeitem", { name: "analytics" })).toBeNull();
  });
});

describe("drag between groups", () => {
  it("moves a connection onto another group header", () => {
    render(<ExplorerPanel />);
    const drag = { dataTransfer: { setData: vi.fn(), effectAllowed: "" } };
    fireEvent.dragStart(row(/prod-postgres/), drag);
    fireEvent.dragOver(row("Staging"), drag);
    expect(row("Staging")).toHaveAttribute("data-drop", "true");
    fireEvent.drop(row("Staging"), drag);
    expect(api.move).toHaveBeenCalledWith("c1", "g2");
  });

  it("ignores a drop on the connection's own group", () => {
    render(<ExplorerPanel />);
    const drag = { dataTransfer: { setData: vi.fn(), effectAllowed: "" } };
    fireEvent.dragStart(row(/prod-postgres/), drag);
    fireEvent.drop(row("Production"), drag);
    expect(api.move).not.toHaveBeenCalled();
  });
});

describe("filter", () => {
  const type = (value: string) =>
    fireEvent.change(screen.getByLabelText("Filter explorer"), { target: { value } });

  it('"ord" keeps orders, order_items and their ancestors, highlighting the match', () => {
    render(<ExplorerPanel />);
    type("ord");
    const labels = screen.getAllByRole("treeitem").map((r) => r.textContent);
    expect(labels).toEqual([
      "Production",
      expect.stringContaining("prod-postgres"),
      "analytics",
      "public",
      "tables3",
      "orders12.4k",
      "order_items98k",
    ]);
    const marks = [...document.querySelectorAll("mark")].map((m) => m.textContent);
    expect(marks).toEqual(["ord", "ord"]);
    expect(screen.queryByRole("treeitem", { name: "billing" })).toBeNull();
  });

  it("matches case-insensitively and Esc clears it", () => {
    render(<ExplorerPanel />);
    type("ORD");
    expect(screen.getAllByRole("treeitem").length).toBe(7);
    fireEvent.keyDown(screen.getByLabelText("Filter explorer"), { key: "Escape" });
    expect(useExplorer.getState().filter).toBe("");
  });

  it("says so when nothing loaded matches", () => {
    render(<ExplorerPanel />);
    type("zzz");
    expect(
      screen.getByText(/No loaded objects match — use .*K to search everything/),
    ).toBeInTheDocument();
  });

  it("matches connection names too", () => {
    render(<ExplorerPanel />);
    type("dev-m");
    expect(screen.getAllByRole("treeitem").map((r) => r.textContent)).toEqual([
      "Ungrouped",
      expect.stringContaining("dev-mongo"),
    ]);
  });
});

describe("keyboard", () => {
  const key = (k: string, extra: object = {}) => fireEvent.keyDown(tree(), { key: k, ...extra });
  const selected = () => useExplorer.getState().selectedId;

  it("moves with Up/Down/Home/End", () => {
    render(<ExplorerPanel />);
    key("ArrowDown");
    expect(selected()).toBe("group:g1");
    key("ArrowDown");
    expect(selected()).toBe("c1");
    key("ArrowUp");
    expect(selected()).toBe("group:g1");
    key("End");
    expect(selected()).toBe("c2");
    key("Home");
    expect(selected()).toBe("group:g1");
  });

  it("Right expands or goes to the first child; Left collapses or goes to the parent", () => {
    seed({ expandAll: false, selected: "c1" });
    useExplorer.setState((s) => ({
      nodes: { ...s.nodes, c1: { ...s.nodes.c1, state: "loaded" } },
    }));
    api.children.mockResolvedValue([]);
    render(<ExplorerPanel />);
    key("ArrowRight"); // expand c1
    expect(useExplorer.getState().expanded.has("c1")).toBe(true);
    key("ArrowRight"); // first child
    expect(selected()).toBe(DB);
    key("ArrowLeft"); // db is collapsed? it was not expanded -> parent
    expect(selected()).toBe("c1");
    key("ArrowLeft"); // collapse c1
    expect(useExplorer.getState().expanded.has("c1")).toBe(false);
    key("ArrowLeft"); // up to the group header
    expect(selected()).toBe("group:g1");
  });

  it("Enter runs the default action: console for a connection, table editor for a table", () => {
    record("connection.open");
    record("table.open");
    seed({ selected: "c1" });
    registerExplorerCommands();
    render(<ExplorerPanel />);
    key("Enter");
    expect(calls["connection.open"]).toEqual(["c1"]);
    act(() => useExplorer.getState().select(ORDERS));
    key("Enter");
    expect(calls["table.open"]).toEqual([
      { connectionId: "c1", path: expect.arrayContaining([{ kind: "table", name: "orders" }]) },
    ]);
  });

  it("Enter on a schema toggles it", async () => {
    seed({ selected: SCHEMA });
    render(<ExplorerPanel />);
    key("Enter");
    expect(useExplorer.getState().expanded.has(SCHEMA)).toBe(false);
  });

  it("type-ahead jumps to the next visible row starting with the letters", () => {
    seed({ selected: "c1" });
    render(<ExplorerPanel />);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1000);
    key("u");
    expect(selected()).toContain("column:user_id");
    now.mockReturnValue(5000); // the buffer has timed out
    key("s");
    expect(selected()).toContain("column:status");
    now.mockRestore();
  });

  it("opens the context menu with the context-menu key and Shift+F10", () => {
    seed({ selected: ORDERS });
    registerExplorerCommands();
    render(<ExplorerPanel />);
    key("ContextMenu");
    expect(screen.getByRole("menu", { name: "Explorer actions" })).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    key("F10", { shiftKey: true });
    expect(screen.getByRole("menuitem", { name: "Generate DDL" })).toBeInTheDocument();
  });
});

describe("context menus", () => {
  const names = () => screen.getAllByRole("menuitem").map((i) => i.textContent);

  it("connection", () => {
    render(<ExplorerPanel />);
    fireEvent.contextMenu(row(/prod-postgres/));
    expect(names()).toEqual(
      expect.arrayContaining([
        "Disconnect",
        "New console",
        "Edit…",
        "Duplicate",
        "Rename…",
        "Delete…",
        "Refresh",
      ]),
    );
    expect(names().some((n) => n?.startsWith("Change environment"))).toBe(true);
  });

  it("database, table, column", () => {
    render(<ExplorerPanel />);
    fireEvent.contextMenu(row("analytics"));
    expect(names()).toEqual(["New console here", "Refresh", "Copy name"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.contextMenu(row(/^orders/));
    expect(names()).toEqual([
      "Open data",
      "Open in console",
      "Copy name",
      "Copy qualified name",
      "Generate DDL",
      "Count rows",
      "Refresh",
    ]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    fireEvent.contextMenu(row(/^id/));
    expect(names()).toEqual(["Copy name", "Filter table by this column"]);
  });

  it("Open in console passes a SELECT with the qualified name", () => {
    record("console.new");
    registerExplorerCommands();
    render(<ExplorerPanel />);
    fireEvent.contextMenu(row(/^orders/));
    fireEvent.click(screen.getByRole("menuitem", { name: "Open in console" }));
    expect(calls["console.new"]).toEqual([
      {
        connectionId: "c1",
        database: "analytics",
        schema: "public",
        sql: 'SELECT * FROM "public"."orders" LIMIT 100;',
      },
    ]);
  });

  it("Generate DDL opens a console with the statement", async () => {
    record("console.new");
    registerExplorerCommands();
    api.ddl.mockResolvedValue("CREATE TABLE orders (id int8);");
    render(<ExplorerPanel />);
    fireEvent.contextMenu(row(/^orders/));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Generate DDL" })));
    expect(calls["console.new"]).toEqual([
      expect.objectContaining({ connectionId: "c1", sql: "CREATE TABLE orders (id int8);" }),
    ]);
  });

  it("Count rows replaces the estimate in place", async () => {
    registerExplorerCommands();
    api.count.mockResolvedValue(12480);
    render(<ExplorerPanel />);
    fireEvent.contextMenu(row(/^orders/));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Count rows" })));
    expect(api.count).toHaveBeenCalledWith("c1", expect.any(Array));
    expect(row(/^orders/)).toHaveTextContent("12.5k");
  });

  it("Copy qualified name writes to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    registerExplorerCommands();
    render(<ExplorerPanel />);
    fireEvent.contextMenu(row(/^orders/));
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy qualified name" })),
    );
    expect(writeText).toHaveBeenCalledWith('"public"."orders"');
  });
});
