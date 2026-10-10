import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { NodePath, ResultEvent, Value } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, registerCommand, runCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds, getTabKind } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import type { TableMeta } from "./api";
import { clearTableRuntimes } from "./runtime";
import { TABLE_KIND } from "./state";
import type { TableTabState } from "./state";
import { TableEditor } from "./TableEditor";
import { openTable, registerTableCommands, registerTableTab } from "./TableTab";

const api = vi.hoisted(() => ({
  execute: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  meta: vi.fn(),
  query: vi.fn(),
  ddl: vi.fn(),
}));

vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: (...a: unknown[]) => api.execute(...a),
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  introspectDdl: (...a: unknown[]) => api.ddl(...a),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("./api", () => ({
  tableMeta: (...a: unknown[]) => api.meta(...a),
  tableQuerySql: (...a: unknown[]) => api.query(...a),
}));
vi.mock("../grid/ResultGrid", async () => {
  const { FakeResultGrid } = await import("../grid/testing");
  return { ResultGrid: FakeResultGrid, autoWidth: () => 100 };
});
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));

const PATH: NodePath = [
  { kind: "database", name: "analytics" },
  { kind: "schema", name: "public" },
  { kind: "group", name: "tables" },
  { kind: "table", name: "orders" },
];

const prod = {
  ...toConnection({ ...newDraft("postgres"), id: "c1", name: "prod-postgres", host: "h" }),
  environment: "production" as const,
  safeguards: { readOnlyByDefault: false, confirmWrites: true, manualCommit: true },
};

const col = (name: string, type_name: string, kind: "int" | "text") => ({
  name,
  type_name,
  kind,
  nullable: false,
});
const COLUMNS = [
  col("id", "int8", "int"),
  col("user_id", "int8", "int"),
  col("status", "text", "text"),
];
const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s });
const PAGE: Value[][] = [
  [int(1), int(1042), text("pending")],
  [int(2), int(77), text("shipped")],
];

const META: TableMeta = {
  columns: [
    {
      name: "id",
      typeName: "int8",
      nullable: false,
      default: null,
      primaryKey: true,
      comment: null,
    },
    {
      name: "user_id",
      typeName: "int8",
      nullable: false,
      default: null,
      primaryKey: false,
      comment: "Owner",
    },
    {
      name: "status",
      typeName: "text",
      nullable: true,
      default: "'new'::text",
      primaryKey: false,
      comment: null,
    },
  ],
  indexes: [
    {
      name: "orders_pkey",
      columns: ["id"],
      unique: true,
      primary: true,
      method: "btree",
      sizeBytes: 16384,
    },
    {
      name: "orders_status_idx",
      columns: ["status"],
      unique: false,
      primary: false,
      method: "btree",
      sizeBytes: null,
    },
  ],
  foreignKeys: [
    {
      name: "orders_user_fk",
      columns: ["user_id"],
      refSchema: "public",
      refTable: "users",
      refColumns: ["id"],
      onUpdate: "NO ACTION",
      onDelete: "CASCADE",
    },
  ],
  referencedBy: [
    {
      name: "items_order_fk",
      schema: "public",
      table: "order_items",
      columns: ["order_id"],
      refColumns: ["id"],
    },
  ],
  estimatedRows: 1284,
};

type Send = (e: ResultEvent) => void;
let nextResult = 1;

/** Answer the SELECT with `rows`, the COUNT with `count`. */
function database(opts: { rows?: Value[][]; count?: number; selectError?: string } = {}) {
  api.execute.mockImplementation(async (_s: string, req: { sql: string }, send: Send) => {
    const id = nextResult++;
    if (req.sql.startsWith("SELECT count")) {
      send({
        event: "columns",
        result_id: id,
        statement: 0,
        columns: [col("count", "int8", "int")],
      });
      send({ event: "rows", result_id: id, rows: [[int(opts.count ?? 1284)]] });
      send({
        event: "done",
        result_id: id,
        summary: { rows_affected: null, elapsed_ms: 2, has_more: false },
      });
      return null;
    }
    if (
      opts.selectError &&
      /WHERE|ORDER BY \w+ \w+ nope/.test(req.sql) &&
      req.sql.includes("nope")
    ) {
      send({
        event: "error",
        result_id: null,
        statement: 0,
        error: { code: "query_failed", message: opts.selectError },
      });
      return null;
    }
    send({ event: "columns", result_id: id, statement: 0, columns: COLUMNS });
    send({ event: "rows", result_id: id, rows: opts.rows ?? PAGE });
    send({
      event: "done",
      result_id: id,
      summary: { rows_affected: null, elapsed_ms: 41, has_more: false },
    });
    return null;
  });
}

let offTab: () => void = () => {};
let offCommands: () => void = () => {};
const consoleCalls: unknown[] = [];

/** Like the editor area: always hands the editor the tab as it is now. */
function Live({ id }: { id: string }) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === id));
  return tab ? <TableEditor tab={tab as never} /> : null;
}

function mount(extra: Partial<TableTabState> = {}) {
  const id = openTable("c1", PATH, extra);
  render(<Live id={id} />);
  return id;
}
const tabState = () => useWorkspace.getState().tabs[0].state as TableTabState;
const rows = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole("gridcell")
        .map((c) => c.textContent),
    );

beforeEach(() => {
  vi.clearAllMocks();
  nextResult = 1;
  consoleCalls.length = 0;
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearTableRuntimes();
  setPlatformForTests("mac");
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "PostgreSQL", version: "16" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  api.meta.mockResolvedValue(META);
  api.ddl.mockResolvedValue('CREATE TABLE "public"."orders" (id bigint);');
  api.query.mockImplementation(
    async (
      _c: string,
      r: {
        whereClause: string | null;
        orderBy: string | null;
        offset: number;
        limit: number;
        defaultOrder: string[];
      },
    ) => {
      const w = r.whereClause ? ` WHERE (${r.whereClause})` : "";
      const o =
        r.orderBy ?? (r.defaultOrder.length ? r.defaultOrder.map((c) => `"${c}"`).join(", ") : "");
      return {
        select: `SELECT * FROM "public"."orders"${w}${o ? ` ORDER BY ${o}` : ""}${r.limit ? ` LIMIT ${r.limit} OFFSET ${r.offset}` : ""}`,
        count: `SELECT count(*) FROM "public"."orders"${w}`,
        table: '"public"."orders"',
      };
    },
  );
  database();
  useConnections.setState({
    file: { version: 1, groups: [], connections: [prod] },
    connected: {},
    busy: {},
    connect: vi.fn(async (id: string) => {
      useConnections.setState((s) => ({ connected: { ...s.connected, [id]: {} as never } }));
      return true;
    }),
  });
  offTab = registerTableTab();
  offCommands = registerTableCommands();
  registerCommand({
    id: "console.new",
    title: "x",
    category: "t",
    run: (a) => void consoleCalls.push(a),
  });
});
afterEach(() => {
  offTab();
  offCommands();
});

describe("opening a table", () => {
  it("opens a tab titled with the table and loads the first page ordered by the primary key", async () => {
    mount();
    expect(getTabKind(TABLE_KIND)!.title(tabState())).toBe("orders");
    await screen.findByRole("grid");
    expect(rows()).toEqual([
      ["1", "1042", "pending"],
      ["2", "77", "shipped"],
    ]);
    const select = api.execute.mock.calls[0][1].sql;
    expect(select).toBe('SELECT * FROM "public"."orders" ORDER BY "id" LIMIT 500 OFFSET 0');
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(
      "prod-postgresanalyticspublicorders",
    );
    expect(screen.getByText("PRODUCTION · WRITES NEED CONFIRMATION")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Data" })).toHaveAttribute("aria-selected", "true");
  });

  it("reuses the tab for the same table (table.open)", async () => {
    await act(
      async () => void (await runCommand("table.open", { connectionId: "c1", path: PATH })),
    );
    await act(
      async () => void (await runCommand("table.open", { connectionId: "c1", path: PATH })),
    );
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(tabState()).toMatchObject({ connectionId: "c1", view: "data", page: 0 });
  });

  it("shows the key and the foreign key target in the column headers", async () => {
    mount();
    await screen.findByRole("grid");
    expect(await screen.findByRole("columnheader", { name: /id\s*int8 · PK/ })).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: /user_id\s*int8 → users\.id/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("columnheader", { name: /status\s*text · nullable/ }),
    ).toBeInTheDocument();
  });

  it("opens the current query in a console", async () => {
    mount();
    await screen.findByRole("grid");
    fireEvent.click(screen.getByRole("button", { name: /Open in console/ }));
    expect(consoleCalls).toEqual([
      {
        connectionId: "c1",
        database: "analytics",
        schema: "public",
        sql: 'SELECT * FROM "public"."orders" ORDER BY "id" LIMIT 500 OFFSET 0;',
      },
    ]);
  });
});

describe("filter and order", () => {
  it("applies WHERE and ORDER BY on Enter and reloads", async () => {
    mount();
    await screen.findByRole("grid");
    fireEvent.change(screen.getByLabelText("WHERE"), {
      target: { value: "status = 'pending' AND total > 100" },
    });
    fireEvent.change(screen.getByLabelText("ORDER BY"), { target: { value: "created_at DESC" } });
    expect(api.execute).toHaveBeenCalledTimes(2); // first page + its count; nothing yet
    fireEvent.keyDown(screen.getByLabelText("WHERE"), { key: "Enter" });
    await waitFor(() => expect(tabState().where).toBe("status = 'pending' AND total > 100"));
    expect(tabState()).toMatchObject({ orderBy: "created_at DESC", page: 0 });
    await waitFor(() =>
      expect(
        api.execute.mock.calls.some(([, r]) =>
          r.sql.includes("WHERE (status = 'pending' AND total > 100) ORDER BY created_at DESC"),
        ),
      ).toBe(true),
    );
  });

  it("shows a rejected filter under the input and keeps the previous rows", async () => {
    mount();
    await screen.findByRole("grid");
    expect(rows()).toHaveLength(2);
    database({ rows: [], selectError: 'syntax error at or near "nope"' });
    fireEvent.change(screen.getByLabelText("WHERE"), { target: { value: "status = nope nope" } });
    fireEvent.keyDown(screen.getByLabelText("WHERE"), { key: "Enter" });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('syntax error at or near "nope"');
    expect(rows()).toEqual([
      ["1", "1042", "pending"],
      ["2", "77", "shipped"],
    ]);
    expect(screen.getByLabelText("WHERE")).toHaveAttribute("aria-invalid", "true");
  });

  it("suggests column names while typing and inserts one", async () => {
    mount();
    await screen.findByRole("grid");
    const where = screen.getByLabelText("WHERE") as HTMLInputElement;
    where.focus();
    fireEvent.change(where, { target: { value: "sta", selectionStart: 3 } });
    const list = await screen.findByRole("listbox", { name: "WHERE columns" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["status"]);
    fireEvent.keyDown(where, { key: "Tab" });
    expect(where.value).toBe("status");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("adds a quick filter from a cell, ANDed with the existing WHERE", async () => {
    mount({ where: "user_id = 1042" });
    await screen.findByRole("grid");
    const cell = within(screen.getAllByRole("row")[1]).getAllByRole("gridcell")[2];
    fireEvent.contextMenu(cell);
    fireEvent.click(screen.getByRole("menuitem", { name: "Filter › Equals" }));
    await waitFor(() => expect(tabState().where).toBe(`user_id = 1042 AND "status" = 'pending'`));
    expect((screen.getByLabelText("WHERE") as HTMLInputElement).value).toBe(
      `user_id = 1042 AND "status" = 'pending'`,
    );
  });

  it("starts a condition when asked to filter by a column", async () => {
    await act(
      async () =>
        void (await runCommand("table.filterByColumn", {
          connectionId: "c1",
          path: PATH,
          column: "status",
        })),
    );
    mount();
    await screen.findByRole("grid");
    await waitFor(() =>
      expect((screen.getByLabelText("WHERE") as HTMLInputElement).value).toBe(`"status" = `),
    );
    expect(tabState().where).toBe(""); // typed, not applied
  });

  it("sorts in the database from a header click", async () => {
    mount();
    await screen.findByRole("grid");
    fireEvent.click(screen.getByRole("columnheader", { name: /status/ }));
    await waitFor(() => expect(tabState().orderBy).toBe('"status" ASC'));
    fireEvent.click(screen.getByRole("columnheader", { name: /status/ }));
    await waitFor(() => expect(tabState().orderBy).toBe('"status" DESC'));
    fireEvent.click(screen.getByRole("columnheader", { name: /status/ }));
    await waitFor(() => expect(tabState().orderBy).toBe(""));
    await waitFor(() =>
      expect(api.execute.mock.calls.some(([, r]) => r.sql.includes('ORDER BY "status" DESC'))).toBe(
        true,
      ),
    );
  });

  it("clears both fragments", async () => {
    mount({ where: "a = 1", orderBy: "id DESC" });
    await screen.findByRole("grid");
    fireEvent.click(screen.getByRole("button", { name: "Clear filter" }));
    await waitFor(() => expect(tabState()).toMatchObject({ where: "", orderBy: "" }));
  });
});

describe("paging and counts", () => {
  it("shows the range with an exact count for a small table", async () => {
    mount({ pageSize: 100 });
    await screen.findByRole("grid");
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Rows 1–2 of 1,284 · 41 ms"),
    );
  });

  it("loads rows 101–200 on the next page", async () => {
    mount({ pageSize: 100 });
    await screen.findByRole("grid");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("of 1,284"));
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(tabState().page).toBe(1));
    await waitFor(() =>
      expect(api.execute.mock.calls.some(([, r]) => r.sql.endsWith("LIMIT 100 OFFSET 100"))).toBe(
        true,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Rows 101–102 of 1,284"),
    );
    expect(screen.getByRole("button", { name: "Previous page" })).toBeEnabled();
  });

  it("stops at the last page", async () => {
    database({ count: 2 });
    mount({ pageSize: 100 });
    await screen.findByRole("grid");
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
  });

  it("changes the page size and goes back to page one", async () => {
    mount({ page: 3 });
    await screen.findByRole("grid");
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "1000" } });
    await waitFor(() => expect(tabState()).toMatchObject({ pageSize: 1000, page: 0 }));
  });

  it("shows ≈ the estimate for a big table and counts exactly on request", async () => {
    api.meta.mockResolvedValue({ ...META, estimatedRows: 12_480_000 });
    mount();
    await screen.findByRole("grid");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("of ≈12,480,000"));
    expect(api.execute.mock.calls.every(([, r]) => !r.sql.startsWith("SELECT count"))).toBe(true);
    database({ count: 12_480_113 });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Count exactly" })));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("of 12,480,113"));
  });

  it("offers the exact count instead of an estimate for a filtered big table", async () => {
    api.meta.mockResolvedValue({ ...META, estimatedRows: 5_000_000 });
    mount({ where: "status = 'x'" });
    await screen.findByRole("grid");
    expect(await screen.findByRole("button", { name: "Count exactly" })).toBeInTheDocument();
    expect(screen.getByRole("status")).not.toHaveTextContent("of");
  });
});

describe("structure, indexes, relations and DDL", () => {
  it("lists the columns with type, nullability, default, keys and comments", async () => {
    mount();
    await screen.findByRole("grid");
    fireEvent.click(screen.getByRole("tab", { name: "Structure" }));
    const table = await screen.findByRole("table", { name: "Columns" });
    const rows = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((r) =>
        within(r)
          .getAllByRole("cell")
          .map((c) => c.textContent?.trim()),
      );
    expect(rows).toEqual([
      ["id", "int8", "no", "", "PK", ""],
      ["user_id", "int8", "no", "", "FK → users.id", "Owner"],
      ["status", "text", "yes", "'new'::text", "", ""],
    ]);
  });

  it("lists the indexes", async () => {
    mount({ view: "indexes" });
    const table = await screen.findByRole("table", { name: "Indexes" });
    expect(within(table).getByText("orders_pkey")).toBeInTheDocument();
    expect(within(table).getByText("16.0 KB")).toBeInTheDocument();
    expect(within(table).getAllByRole("row")).toHaveLength(3);
  });

  it("lists relations and opens the other table", async () => {
    mount({ view: "relations" });
    const out = await screen.findByRole("table", { name: "Outgoing foreign keys" });
    expect(within(out).getByText("user_id → id")).toBeInTheDocument();
    expect(within(out).getByText("CASCADE")).toBeInTheDocument();
    fireEvent.click(within(out).getByRole("button", { name: "users" }));
    await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
    const opened = useWorkspace.getState().tabs[1].state as TableTabState;
    expect(opened.path.map((s) => s.name)).toEqual(["analytics", "public", "tables", "users"]);
    const into = screen.getByRole("table", { name: "Incoming foreign keys" });
    expect(within(into).getByRole("button", { name: "order_items" })).toBeInTheDocument();
  });

  it("shows the DDL with Copy and Open in console", async () => {
    mount({ view: "ddl" });
    expect(await screen.findByLabelText("DDL")).toHaveTextContent(
      'CREATE TABLE "public"."orders" (id bigint);',
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith('CREATE TABLE "public"."orders" (id bigint);');
    fireEvent.click(screen.getAllByRole("button", { name: "Open in console" }).slice(-1)[0]);
    expect(consoleCalls.slice(-1)[0]).toMatchObject({
      sql: 'CREATE TABLE "public"."orders" (id bigint);',
    });
  });

  it("reports a metadata failure", async () => {
    api.meta.mockRejectedValue({ message: "permission denied for table orders" });
    mount({ view: "structure" });
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "permission denied for table orders",
    );
  });
});

describe("restoring and the session", () => {
  it("keeps its query across a restart but not its session", async () => {
    const id = mount({ where: "a = 1", orderBy: "id DESC", page: 2, pageSize: 100 });
    await screen.findByRole("grid");
    const kind = getTabKind(TABLE_KIND)!;
    const raw = JSON.parse(
      JSON.stringify(
        kind.serialize!(useWorkspace.getState().tabs.find((t) => t.id === id)!.state as never),
      ),
    );
    expect(raw.sessionId).toBeUndefined();
    expect(kind.deserialize!(raw)).toMatchObject({
      where: "a = 1",
      orderBy: "id DESC",
      page: 2,
      pageSize: 100,
      view: "data",
    });
    expect(() => kind.deserialize!({ connectionId: "c1" })).toThrow();
  });

  it("closes its session with the tab", async () => {
    const id = mount();
    await screen.findByRole("grid");
    useWorkspace.getState().closeTab(id);
    expect(api.sessionClose).toHaveBeenCalledWith("s1");
  });
});
