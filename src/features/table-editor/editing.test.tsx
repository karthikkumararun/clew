import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { NodePath, ResultEvent, Value } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, registerCommand } from "../../shell/registry/commands";
import { clearShortcuts, installShortcutListener } from "../../shell/registry/shortcuts";
import { clearTabKinds, getTabKind } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { ConsolePromptHost } from "../console/prompts";
import * as safety from "../safety/ipc";
import { SafetyPromptHost, clearConfirms } from "../safety/confirm";
import type { TableMeta } from "./api";
import { clearTableRuntimes, peekTableRuntime } from "./runtime";
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
  preview: vi.fn(),
  apply: vi.fn(),
}));

vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: (...a: unknown[]) => api.execute(...a),
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  introspectDdl: vi.fn(),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("./api", () => ({
  tableMeta: (...a: unknown[]) => api.meta(...a),
  tableQuerySql: (...a: unknown[]) => api.query(...a),
  changesPreview: (...a: unknown[]) => api.preview(...a),
  changesApply: (...a: unknown[]) => api.apply(...a),
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

const base = toConnection({ ...newDraft("postgres"), id: "c1", name: "prod-postgres", host: "h" });
const writable: typeof base = {
  ...base,
  environment: "development",
  safeguards: { readOnlyByDefault: false, confirmWrites: false, manualCommit: false },
};
const guarded: typeof base = {
  ...base,
  environment: "production",
  safeguards: { readOnlyByDefault: false, confirmWrites: true, manualCommit: true },
};
const readOnly: typeof base = {
  ...base,
  environment: "production",
  safeguards: { readOnlyByDefault: true, confirmWrites: true, manualCommit: true },
};

const col = (name: string, type_name: string, kind: "int" | "text") => ({
  name,
  type_name,
  kind,
  nullable: false,
});
const COLUMNS = [col("id", "int8", "int"), col("status", "text", "text")];
const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s });
const PAGE: Value[][] = [
  [int(88213), text("pending")],
  [int(88214), text("shipped")],
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
      name: "status",
      typeName: "text",
      nullable: false,
      default: null,
      primaryKey: false,
      comment: null,
    },
  ],
  indexes: [],
  foreignKeys: [],
  referencedBy: [],
  estimatedRows: 2,
};

type Send = (e: ResultEvent) => void;
let nextResult = 1;
let totalRows = 2;
function database() {
  api.execute.mockImplementation(async (_s: string, req: { sql: string }, send: Send) => {
    const id = nextResult++;
    if (req.sql.startsWith("SELECT count")) {
      send({
        event: "columns",
        result_id: id,
        statement: 0,
        columns: [col("count", "int8", "int")],
      });
      send({ event: "rows", result_id: id, rows: [[int(totalRows)]] });
    } else {
      send({ event: "columns", result_id: id, statement: 0, columns: COLUMNS });
      send({ event: "rows", result_id: id, rows: PAGE });
    }
    send({
      event: "done",
      result_id: id,
      summary: { rows_affected: null, elapsed_ms: 3, has_more: false },
    });
    return null;
  });
}

let offTab: () => void = () => {};
let offCommands: () => void = () => {};
let offKeys: () => void = () => {};

function Live({ id }: { id: string }) {
  const tab = useWorkspace((s) => s.tabs.find((t) => t.id === id));
  return tab ? <TableEditor tab={tab as never} /> : null;
}
async function mount(connection = writable, extra: Partial<TableTabState> = {}) {
  useConnections.setState({ file: { version: 1, groups: [], connections: [connection] } });
  const id = openTable("c1", PATH, { pageSize: 100, ...extra });
  render(
    <>
      <Live id={id} />
      <ConsolePromptHost />
      <SafetyPromptHost />
    </>,
  );
  await screen.findByRole("grid");
  await waitFor(() => expect(peekTableRuntime(id)!.store.getState().meta).not.toBeNull());
  return id;
}
const cellOf = (row: number, c: number) =>
  within(screen.getAllByRole("row")[row + 1]).getAllByRole("gridcell")[c];
const tabState = () => useWorkspace.getState().tabs[0].state as TableTabState;

async function edit(row: number, c: number, value: string) {
  fireEvent.doubleClick(cellOf(row, c));
  const input = await screen.findByLabelText(/^Value of /);
  fireEvent.change(input, { target: { value } });
  fireEvent.click(screen.getByRole("button", { name: "Apply" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

beforeEach(() => {
  vi.clearAllMocks();
  nextResult = 1;
  totalRows = 2;
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearTableRuntimes();
  clearConfirms();
  vi.mocked(safety.sessionReadOnly).mockResolvedValue(false);
  vi.mocked(safety.safetyCheckChanges).mockImplementation(async () => ({
    decision: "allow",
    connection: "",
    environment: "",
    statements: [],
  }));
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
  api.query.mockImplementation(async (_c: string, r: { offset: number; limit: number }) => ({
    select: `SELECT * FROM "public"."orders" ORDER BY "id" LIMIT ${r.limit} OFFSET ${r.offset}`,
    count: 'SELECT count(*) FROM "public"."orders"',
    table: '"public"."orders"',
  }));
  api.preview.mockResolvedValue([
    {
      kind: "update",
      sql: `UPDATE "public"."orders" SET "status" = 'shipped' WHERE "id" = 88213;`,
      target: { kind: "update", index: 0 },
    },
  ]);
  api.apply.mockResolvedValue({ applied: 1, failure: null });
  database();
  useConnections.setState({
    connected: {},
    busy: {},
    connect: vi.fn(async (id: string) => {
      useConnections.setState((s) => ({ connected: { ...s.connected, [id]: {} as never } }));
      return true;
    }),
  });
  offTab = registerTableTab();
  offCommands = registerTableCommands();
  offKeys = installShortcutListener(window);
  registerCommand({ id: "console.new", title: "x", category: "t", run: () => {} });
});
afterEach(() => {
  offTab();
  offCommands();
  offKeys();
});

describe("which tables can be edited", () => {
  it("explains a session that is read-only", async () => {
    vi.mocked(safety.sessionReadOnly).mockResolvedValue(true);
    await mount(readOnly);
    expect(screen.getByRole("note")).toHaveTextContent("Read-only: this session is read-only");
    expect(screen.getByRole("button", { name: "PRODUCTION · READ-ONLY" })).toBeInTheDocument();
    fireEvent.doubleClick(cellOf(0, 1));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("button", { name: "Add row" })).toBeDisabled();
  });

  it("explains a table without a unique key", async () => {
    api.meta.mockResolvedValue({
      ...META,
      columns: META.columns.map((c) => ({ ...c, primaryKey: false })),
    });
    await mount();
    expect(await screen.findByRole("note")).toHaveTextContent(
      "Read-only: result has no unique key",
    );
    fireEvent.doubleClick(cellOf(0, 1));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("is editable with a primary key", async () => {
    await mount();
    expect(screen.queryByRole("note")).toBeNull();
    expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled();
  });
});

describe("staging edits", () => {
  it("edits a cell, marks it and shows one pending change without writing", async () => {
    await mount();
    await edit(0, 1, "shipped");
    expect(cellOf(0, 1)).toHaveTextContent("shipped");
    expect(cellOf(0, 1)).toHaveAttribute("data-cell", "edited");

    const bar = screen.getByRole("region", { name: "Pending changes" });
    expect(bar).toHaveTextContent("1 pending change");
    expect(bar).toHaveTextContent("1 edited — nothing is written until you submit");
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("rejects a value of the wrong type in the editor", async () => {
    await mount();
    fireEvent.doubleClick(cellOf(0, 0));
    const input = await screen.findByLabelText("Value of id");
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a whole number");
    expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
  });

  it("disables Set NULL for a NOT NULL column", async () => {
    await mount();
    fireEvent.doubleClick(cellOf(0, 1));
    await screen.findByRole("dialog");
    expect(screen.getByRole("button", { name: "Set NULL" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Set DEFAULT" })).toBeEnabled();
  });

  it("undoes a single change with Mod+Z", async () => {
    await mount();
    await edit(0, 1, "shipped");
    await edit(1, 1, "returned");
    expect(screen.getByRole("region", { name: "Pending changes" })).toHaveTextContent(
      "2 pending changes",
    );
    fireEvent.keyDown(screen.getByRole("grid"), { key: "z", metaKey: true });
    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Pending changes" })).toHaveTextContent(
        "1 pending change",
      ),
    );
    expect(cellOf(1, 1)).toHaveTextContent("shipped");
    expect(cellOf(0, 1)).toHaveTextContent("shipped");
  });

  it("adds a row with a green marker and deletes a row with a struck one", async () => {
    await mount();
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await screen.findByRole("dialog"); // the new row's first cell opens for typing
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toHaveAttribute("data-marker", "+");
    expect(rows[2]).toHaveTextContent("DEFAULT");
    fireEvent.click(rows[0]);
    fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
    expect(screen.getAllByRole("row")[1]).toHaveAttribute("data-marker", "−");
    expect(screen.getByRole("region", { name: "Pending changes" })).toHaveTextContent(
      "2 pending changes1 inserted · 1 deleted — nothing is written until you submit",
    );
  });

  it("sets a cell to NULL or DEFAULT from the cell menu", async () => {
    api.meta.mockResolvedValue({
      ...META,
      columns: META.columns.map((c) => (c.name === "status" ? { ...c, nullable: true } : c)),
    });
    await mount();
    fireEvent.contextMenu(cellOf(0, 1));
    fireEvent.click(screen.getByRole("menuitem", { name: "Set NULL" }));
    expect(cellOf(0, 1)).toHaveTextContent("NULL");
    fireEvent.contextMenu(cellOf(1, 1));
    fireEvent.click(screen.getByRole("menuitem", { name: "Set DEFAULT" }));
    expect(cellOf(1, 1)).toHaveTextContent("DEFAULT");
  });

  it("reverts everything", async () => {
    await mount();
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: "Revert all" }));
    expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
    expect(cellOf(0, 1)).toHaveTextContent("pending");
  });
});

describe("preview and submit", () => {
  it("previews the generated SQL, keyed by primary key", async () => {
    await mount();
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: "Preview SQL" }));
    const sql = await screen.findByLabelText("Generated SQL");
    expect(sql).toHaveTextContent(
      `UPDATE "public"."orders" SET "status" = 'shipped' WHERE "id" = 88213;`,
    );
    const req = api.preview.mock.calls[0][1];
    expect(req.keyColumns).toEqual(["id"]);
    expect(req.edits[0]).toEqual({
      key: [int(88213)],
      changes: [
        { column: "status", old: text("pending"), new: { kind: "value", value: text("shipped") } },
      ],
    });
    expect(screen.getByRole("button", { name: "Copy" })).toBeEnabled();
    expect(
      within(screen.getByRole("dialog")).getByRole("button", { name: "Open in console" }),
    ).toBeEnabled();
  });

  it("submits in one call, clears the markers and reloads the rows", async () => {
    await mount();
    await edit(0, 1, "shipped");
    const loads = api.execute.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
    expect(api.apply.mock.calls[0][1]).toBe("s1");
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull(),
    );
    await waitFor(() => expect(api.execute.mock.calls.length).toBeGreaterThan(loads));
    expect(cellOf(0, 1)).toHaveTextContent("pending"); // the database's rows, reloaded
  });

  it("asks first when the guard says the connection confirms writes", async () => {
    const ask = {
      decision: "confirm" as const,
      connection: "prod-postgres",
      environment: "production",
      statements: [
        {
          text: `UPDATE "public"."orders" SET "status" = 'shipped' WHERE "id" = 88213;`,
          class: "write" as const,
          estimate: 1,
        },
      ],
      token: "tok-9",
    };
    vi.mocked(safety.safetyCheckChanges).mockResolvedValue(ask);
    await mount(guarded);
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("prod-postgres · Production");
    expect(dialog).toHaveTextContent("≈1 row");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.apply).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "Pending changes" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", { name: "Confirm" }),
    );
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
    expect(api.apply.mock.calls[0][3]).toBe("tok-9");
  });

  it("shows the block and keeps the changes when the session is read-only", async () => {
    vi.mocked(safety.safetyCheckChanges).mockResolvedValue({
      decision: "block",
      connection: "prod-postgres",
      environment: "production",
      statements: [],
      reason: "This session is read-only",
    });
    await mount(writable);
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    const bar = screen.getByRole("region", { name: "Pending changes" });
    await waitFor(() =>
      expect(within(bar).getByRole("alert")).toHaveTextContent(
        "Blocked: this session is read-only",
      ),
    );
    expect(api.apply).not.toHaveBeenCalled();
    expect(bar).toHaveTextContent("1 pending change");
  });

  it("keeps every change and marks the failing row when the transaction fails", async () => {
    api.apply.mockResolvedValue({
      applied: 0,
      failure: {
        target: { kind: "insert", index: 0 },
        message: 'null value in column "status" violates not-null constraint',
        conflict: false,
      },
    });
    await mount();
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    const bar = screen.getByRole("region", { name: "Pending changes" });
    await waitFor(() =>
      expect(within(bar).getByRole("alert")).toHaveTextContent("violates not-null constraint"),
    );
    expect(bar).toHaveTextContent("2 pending changes");
    expect(cellOf(2, 0)).toHaveAttribute("data-cell", "error");
    expect(cellOf(0, 1)).toHaveAttribute("data-cell", "edited");
    expect(within(bar).queryByRole("button", { name: "Reload" })).toBeNull();
  });

  it("tells the user a row changed under them and offers to reload", async () => {
    api.apply.mockResolvedValue({
      applied: 0,
      failure: {
        target: { kind: "update", index: 0 },
        message: "The row was changed or deleted by someone else since it was loaded.",
        conflict: true,
      },
    });
    await mount();
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: /^Submit/ }));
    const bar = screen.getByRole("region", { name: "Pending changes" });
    await waitFor(() =>
      expect(within(bar).getByRole("alert")).toHaveTextContent("Row changed by someone else"),
    );
    expect(cellOf(0, 0)).toHaveAttribute("data-cell", "error");
    fireEvent.click(within(bar).getByRole("button", { name: "Reload" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard and reload" }));
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull(),
    );
  });
});

describe("leaving with pending changes", () => {
  it("stays on the page when cancelled", async () => {
    totalRows = 500;
    await mount(writable, { page: 0 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("1 pending change (1 edited)");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(tabState().page).toBe(0);
    expect(screen.getByRole("region", { name: "Pending changes" })).toBeInTheDocument();
  });

  it("drops the changes and moves on when discarded", async () => {
    totalRows = 500;
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await waitFor(() => expect(tabState().page).toBe(1));
    expect(screen.queryByRole("region", { name: "Pending changes" })).toBeNull();
    expect(api.apply).not.toHaveBeenCalled();
  });

  it("submits first when asked, then moves on", async () => {
    totalRows = 500;
    await mount();
    await waitFor(() => expect(screen.getByRole("button", { name: "Next page" })).toBeEnabled());
    await edit(0, 1, "shipped");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    fireEvent.click(await screen.findByRole("button", { name: "Submit" }));
    await waitFor(() => expect(api.apply).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(tabState().page).toBe(1));
  });

  it("asks before closing the tab", async () => {
    const id = await mount();
    await edit(0, 1, "shipped");
    const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
    const answer = getTabKind(TABLE_KIND)!.confirmClose!(tab as never);
    const dialog = await screen.findByRole("dialog");
    expect(dialog).toHaveTextContent("1 pending change");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await act(async () => expect(await answer).toBe(false));
    const again = getTabKind(TABLE_KIND)!.confirmClose!(tab as never);
    fireEvent.click(await screen.findByRole("button", { name: "Discard" }));
    await act(async () => expect(await again).toBe(true));
  });

  it("closes without a question when nothing is pending", async () => {
    const id = await mount();
    const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
    expect(await getTabKind(TABLE_KIND)!.confirmClose!(tab as never)).toBe(true);
  });
});
