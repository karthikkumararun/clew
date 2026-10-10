import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
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
import type { HistoryEntry } from "./historyIpc";
import { ConsolePromptHost, clearPrompts } from "./prompts";
import { clearRuntimes, getRuntime } from "./runtime";
import type { ConsoleState } from "./state";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  clear: vi.fn(),
  execute: vi.fn(),
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
}));

vi.mock("./historyIpc", () => ({
  historyList: (...a: unknown[]) => api.list(...a),
  historyClear: (...a: unknown[]) => api.clear(...a),
}));
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
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));

const conn = toConnection({ ...newDraft("postgres"), id: "c1", name: "prod-postgres", host: "h" });
const NOW = Date.now();

const entry = (id: number, sql: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id,
  connectionId: "c1",
  database: "analytics",
  sql,
  startedAt: NOW - id * 60_000,
  durationMs: 38,
  rows: 50,
  outcome: "ok",
  ...over,
});

const ENTRIES = [
  entry(3, "SELECT * FROM orders\nWHERE total > 100"),
  entry(2, "UPDATE users SET name = 'x'", { rows: null, outcome: "error", durationMs: 4 }),
  entry(1, "SELECT pg_sleep(60)", { rows: null, outcome: "cancelled", durationMs: 2100 }),
];

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

async function mountHistory(sql = "select 1") {
  const id = (await openConsole({ connectionId: "c1", sql }))!;
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
  const runtime = getRuntime(id, "c1");
  runtime.setTab("history");
  render(
    <>
      <ConsoleView tab={tab as never} />
      <ConsolePromptHost />
    </>,
  );
  return { id, runtime };
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
  api.list.mockResolvedValue({ entries: ENTRIES, next: null });
  api.clear.mockResolvedValue(3);
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "PostgreSQL", version: "16" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  api.execute.mockImplementation(async (_s: string, _r: unknown, send: (e: unknown) => void) => {
    send({
      event: "done",
      result_id: 1,
      summary: { rows_affected: 1, elapsed_ms: 1, has_more: false },
    });
    return null;
  });
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

const listbox = () => screen.findByRole("listbox", { name: "History" });
/** The entries, once they have loaded (the list itself is on screen from the start). */
const options = async () => within(await listbox()).findAllByRole("option");

describe("History tab", () => {
  it("lists the connection's statements newest first with outcome, rows, time and duration", async () => {
    await mountHistory();
    const rows = await options();
    expect(api.list).toHaveBeenCalledWith("c1", "", null);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent("SELECT * FROM orders WHERE total > 100"); // flattened
    expect(rows[0]).toHaveTextContent("50 rows");
    expect(rows[0]).toHaveTextContent("38 ms");
    expect(rows[0]).toHaveTextContent("3 min ago");
    expect(within(rows[0]).getByLabelText("Succeeded")).toBeInTheDocument();
    expect(within(rows[1]).getByLabelText("Failed")).toBeInTheDocument();
    expect(within(rows[2]).getByLabelText("Cancelled")).toBeInTheDocument();
    expect(rows[2]).toHaveTextContent("2100 ms");
  });

  it("says so when nothing was run yet", async () => {
    api.list.mockResolvedValue({ entries: [], next: null });
    await mountHistory();
    expect(await screen.findByText(/Statements you run in this connection/)).toBeInTheDocument();
  });

  it("searches as the user types", async () => {
    await mountHistory();
    await listbox();
    api.list.mockResolvedValue({ entries: [ENTRIES[0]], next: null });
    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "orders" } });
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith("c1", "orders", null));
    await waitFor(() =>
      expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(1),
    );
    api.list.mockResolvedValue({ entries: [], next: null });
    fireEvent.change(screen.getByLabelText("Search history"), { target: { value: "zzz" } });
    expect(await screen.findByText("No statements match.")).toBeInTheDocument();
  });

  it("shows the whole statement of the selected entry", async () => {
    await mountHistory();
    fireEvent.click((await options())[0]);
    const detail = screen.getByRole("complementary", { name: "Statement" });
    expect(detail.querySelector("pre")!.textContent).toBe(
      "SELECT * FROM orders\nWHERE total > 100",
    );
  });

  it("Insert puts the statement into the editor at the cursor", async () => {
    const { id } = await mountHistory("-- notes\n");
    const view = getView(id)!;
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    fireEvent.click((await options())[1]);
    fireEvent.click(screen.getByRole("button", { name: "Insert into editor" }));
    expect(view.state.doc.toString()).toBe("-- notes\nUPDATE users SET name = 'x'");
    const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
    expect((tab.state as ConsoleState).text).toBe("-- notes\nUPDATE users SET name = 'x'");
  });

  it("Open in new console opens the same connection with the text, without running it", async () => {
    await mountHistory();
    fireEvent.click((await options())[2]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Open in new console" })),
    );
    const tabs = useWorkspace.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[1].state).toMatchObject({ connectionId: "c1", text: "SELECT pg_sleep(60)" });
    expect(api.execute).not.toHaveBeenCalled();
  });

  it("Copy writes the statement to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    await mountHistory();
    fireEvent.click((await options())[0]);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith("SELECT * FROM orders\nWHERE total > 100");
  });

  it("loads older entries with the cursor", async () => {
    api.list.mockResolvedValueOnce({ entries: ENTRIES.slice(0, 2), next: 2 });
    await mountHistory();
    await listbox();
    api.list.mockResolvedValueOnce({ entries: ENTRIES.slice(2), next: null });
    fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
    await waitFor(() => expect(api.list).toHaveBeenLastCalledWith("c1", "", 2));
    await waitFor(() =>
      expect(within(screen.getByRole("listbox")).getAllByRole("option")).toHaveLength(3),
    );
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("reads the history afresh each time the tab is opened, so a run shows up", async () => {
    const { runtime } = await mountHistory("select 1");
    await listbox();
    expect(api.list).toHaveBeenCalledTimes(1);
    const view = getView(useWorkspace.getState().tabs[0].id)!;
    act(() => view.dispatch({ selection: { anchor: 3 } }));
    await act(async () => void (await runCommand("console.run")));
    expect(runtime.store.getState().tab).not.toBe("history"); // the run shows its result
    api.list.mockResolvedValue({ entries: [entry(4, "select 1"), ...ENTRIES], next: null });
    fireEvent.click(screen.getByRole("tab", { name: "History" }));
    expect(await screen.findByText("select 1")).toBeInTheDocument();
    expect(api.list).toHaveBeenCalledTimes(2);
  });
});

describe("clearing history", () => {
  async function openClearMenu() {
    await listbox();
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  }

  it("clears one connection after confirmation", async () => {
    await mountHistory();
    await openClearMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear history for prod-postgres/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Delete every recorded statement of/)).toBeInTheDocument();
    expect(api.clear).not.toHaveBeenCalled();
    api.list.mockResolvedValue({ entries: [], next: null });
    await act(async () =>
      fireEvent.click(within(dialog).getByRole("button", { name: "Clear history" })),
    );
    expect(api.clear).toHaveBeenCalledWith("c1");
    expect(useNotices.getState().notices[0].message).toBe("Deleted 3 entries");
    expect(await screen.findByText(/Statements you run in this connection/)).toBeInTheDocument();
  });

  it("clears every connection's history on request", async () => {
    await mountHistory();
    await openClearMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /all connections/ }));
    const dialog = await screen.findByRole("dialog");
    await act(async () =>
      fireEvent.click(within(dialog).getByRole("button", { name: "Clear all" })),
    );
    expect(api.clear).toHaveBeenCalledWith(undefined);
  });

  it("deletes nothing when the confirmation is declined or dismissed", async () => {
    await mountHistory();
    await openClearMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear history for prod-postgres/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Clear history for prod-postgres/ }));
    fireEvent.keyDown(await screen.findByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.clear).not.toHaveBeenCalled();
  });
});
