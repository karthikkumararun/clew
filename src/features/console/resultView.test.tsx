import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { ResultEvent, Value } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { stubLayout } from "../explorer/testing";
import { clearSnapshots } from "./completion/snapshots";
import { registerConsoleTab } from "./ConsoleTab";
import { ConsoleView } from "./ConsoleView";
import { openConsole, registerConsoleCommands } from "./commands";
import { getView } from "./editor/views";
import { ConsolePromptHost, clearPrompts } from "./prompts";
import { orderedSql } from "./ResultsPanel";
import { clearRuntimes } from "./runtime";

const api = vi.hoisted(() => ({ execute: vi.fn(), sessionOpen: vi.fn(), sessionClose: vi.fn() }));
vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: (...a: unknown[]) => api.execute(...a),
  queryCancel: vi.fn(),
  queryFetchMore: vi.fn(),
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  completionSnapshot: vi.fn().mockResolvedValue({ schemas: [] }),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("../grid/ResultGrid", async () => {
  const { FakeResultGrid } = await import("../grid/testing");
  return { ResultGrid: FakeResultGrid, autoWidth: () => 100 };
});
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));

type Send = (e: ResultEvent) => void;
const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s });
const conn = toConnection({ ...newDraft("postgres"), id: "c1", name: "pg", host: "h" });

const COLUMNS = [
  { name: "id", type_name: "int8", kind: "int" as const, nullable: false },
  { name: "name", type_name: "text", kind: "text" as const, nullable: true },
];

let nextResult = 1;
/** Result ids grow over a session, so each run's results are distinct. */
function stream(rows: Value[][], more = false) {
  api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
    const id = nextResult++;
    send({ event: "columns", result_id: id, statement: 0, columns: COLUMNS });
    send({ event: "rows", result_id: id, rows });
    send({
      event: "done",
      result_id: id,
      summary: { rows_affected: null, elapsed_ms: 3, has_more: more },
    });
    return null;
  });
}

const names = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((r) =>
      within(r)
        .getAllByRole("gridcell")
        .map((c) => c.textContent),
    );

beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
});

let restoreLayout: () => void = () => {};
let offTab: () => void = () => {};
let offCommands: () => void = () => {};

async function run(rows: Value[][], more = false) {
  stream(rows, more);
  const id = (await openConsole({ connectionId: "c1", sql: "select id, name from t" }))!;
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
  render(
    <>
      <ConsoleView tab={tab as never} />
      <ConsolePromptHost />
    </>,
  );
  act(() => getView(id)!.dispatch({ selection: { anchor: 3 } }));
  await act(async () => void (await runCommand("console.run")));
  await screen.findByRole("grid");
}

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearRuntimes();
  clearSnapshots();
  clearPrompts();
  setPlatformForTests("mac");
  restoreLayout = stubLayout();
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "PostgreSQL", version: "16" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  useConnections.setState({
    file: { version: 1, groups: [], connections: [conn] },
    connected: {},
    busy: {},
    connect: vi.fn(async (id: string) => {
      useConnections.setState((s) => ({ connected: { ...s.connected, [id]: {} as never } }));
      return true;
    }),
  });
  offTab = registerConsoleTab();
  offCommands = registerConsoleCommands();
});
afterEach(() => {
  offTab();
  offCommands();
  restoreLayout();
});

const ROWS = [
  [int(2), text("b")],
  [int(3), text("c")],
  [int(1), text("a")],
];

describe("sorting loaded rows", () => {
  it("cycles ascending, descending, none from the header", async () => {
    await run(ROWS);
    const header = screen.getByRole("columnheader", { name: "id" });
    expect(names().map((r) => r[0])).toEqual(["2", "3", "1"]);
    fireEvent.click(header);
    expect(names().map((r) => r[0])).toEqual(["1", "2", "3"]);
    expect(header).toHaveAttribute("aria-sort", "ascending");
    fireEvent.click(header);
    expect(names().map((r) => r[0])).toEqual(["3", "2", "1"]);
    fireEvent.click(header);
    expect(names().map((r) => r[0])).toEqual(["2", "3", "1"]);
    expect(header).toHaveAttribute("aria-sort", "none");
  });

  it("says the sort covers only the loaded rows when the server has more", async () => {
    await run(ROWS, true);
    expect(screen.queryByRole("status", { name: "" })).toBeNull();
    fireEvent.click(screen.getByRole("columnheader", { name: "name" }));
    expect(screen.getByText(/Sorted 3 loaded rows —/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Re-run with ORDER BY" })).toBeInTheDocument();
  });

  it("gives no notice when everything was loaded", async () => {
    await run(ROWS, false);
    fireEvent.click(screen.getByRole("columnheader", { name: "name" }));
    expect(screen.queryByText(/loaded rows —/)).toBeNull();
  });

  it("re-runs with ORDER BY only after the user confirms", async () => {
    await run(ROWS, true);
    fireEvent.click(screen.getByRole("columnheader", { name: "name" }));
    fireEvent.click(screen.getByRole("columnheader", { name: "name" })); // descending
    fireEvent.click(screen.getByRole("button", { name: "Re-run with ORDER BY" }));
    const dialog = await screen.findByRole("dialog");
    expect(api.execute).toHaveBeenCalledTimes(1);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Re-run" })));
    expect(api.execute).toHaveBeenCalledTimes(2);
    expect(api.execute.mock.calls[1][1].sql).toBe(
      'SELECT * FROM (select id, name from t) AS clew_sorted ORDER BY "name" DESC',
    );
  });

  it("does nothing when the re-run is declined", async () => {
    await run(ROWS, true);
    fireEvent.click(screen.getByRole("columnheader", { name: "name" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Re-run with ORDER BY" })),
    );
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await act(async () => {});
    expect(api.execute).toHaveBeenCalledTimes(1);
  });

  it("wraps the statement per dialect", () => {
    expect(orderedSql("select 1;", "postgres", "n", "asc")).toBe(
      'SELECT * FROM (select 1) AS clew_sorted ORDER BY "n" ASC',
    );
    expect(orderedSql("select 1", "mysql", "n m", "desc")).toBe(
      "SELECT * FROM (select 1) AS clew_sorted ORDER BY `n m` DESC",
    );
    expect(orderedSql("select 1", "oracle", "n", "asc")).toBe(
      'SELECT * FROM (select 1) clew_sorted ORDER BY "n" ASC',
    );
    expect(orderedSql("select 1", "sqlserver", "n", "asc")).toContain("ORDER BY [n] ASC");
  });
});

describe("columns and transpose", () => {
  it("hides columns from the Columns menu and counts them", async () => {
    await run(ROWS);
    const button = screen.getByRole("button", { name: "Columns · 2 of 2" });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("menuitem", { name: "☑ name" }));
    expect(screen.getByRole("button", { name: "Columns · 1 of 2" })).toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "name" })).toBeNull();
    expect(names().map((r) => r.length)).toEqual([1, 1, 1]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Show all columns" }));
    expect(screen.getByRole("columnheader", { name: "name" })).toBeInTheDocument();
  });

  it("transposes a single row into column name and value", async () => {
    await run([[int(7), text("solo")]]);
    fireEvent.click(screen.getByRole("button", { name: "Transpose" }));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual([
      "column",
      "value",
    ]);
    expect(names()).toEqual([
      ["id", "7"],
      ["name", "solo"],
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Transpose" }));
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["id", "name"]);
  });

  it("filters the loaded rows", async () => {
    await run(ROWS);
    fireEvent.click(screen.getByRole("button", { name: "Filter results" }));
    fireEvent.change(screen.getByLabelText("Filter rows"), { target: { value: "b" } });
    expect(names()).toEqual([["2", "b"]]);
    expect(screen.getByText("1 of 3 match")).toBeInTheDocument();
  });

  it("starts fresh for the next result", async () => {
    await run(ROWS);
    fireEvent.click(screen.getByRole("columnheader", { name: "id" }));
    expect(screen.getByRole("columnheader", { name: "id" })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
    await act(async () => void (await runCommand("console.rerun")));
    expect(screen.getByRole("columnheader", { name: "id" })).toHaveAttribute("aria-sort", "none");
    expect(useNotices.getState().notices).toHaveLength(0);
  });
});
