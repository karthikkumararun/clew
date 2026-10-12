import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import type { ResultEvent } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { useNotices } from "../../stores/noticesStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { stubLayout } from "../explorer/testing";
import { clearSnapshots } from "./completion/snapshots";
import { registerConsoleTab } from "./ConsoleTab";
import { ConsoleToolbar } from "./ConsoleToolbar";
import { ConsoleView } from "./ConsoleView";
import { openConsole, registerConsoleCommands } from "./commands";
import { getView } from "./editor/views";
import { ConsolePromptHost, clearPrompts } from "./prompts";
import { clearRuntimes, getRuntime } from "./runtime";
import type { ConsoleState } from "./state";

const api = vi.hoisted(() => ({ execute: vi.fn(), sessionOpen: vi.fn(), sessionClose: vi.fn() }));
vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
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
const sent = () => api.execute.mock.calls.map((c) => c[1].sql as string);

const pg = toConnection({ ...newDraft("postgres"), id: "c1", name: "pg", host: "h" });
const my = toConnection({ ...newDraft("mysql"), id: "c2", name: "my", host: "h" });

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

async function mountConsole(sql = "update t set a = 1", connectionId = "c1") {
  const id = (await openConsole({ connectionId, sql }))!;
  const tab = useWorkspace.getState().tabs.find((t) => t.id === id)!;
  render(
    <>
      <ConsoleToolbar />
      <ConsoleView tab={tab as never} />
      <ConsolePromptHost />
    </>,
  );
  act(() => getView(id)!.dispatch({ selection: { anchor: 3 } }));
  return { id, runtime: getRuntime(id, connectionId) };
}

const modeOf = (id: string) =>
  (useWorkspace.getState().tabs.find((t) => t.id === id)?.state as ConsoleState).txMode;

async function chooseManual() {
  fireEvent.click(screen.getByRole("button", { name: /^Tx:/ }));
  fireEvent.click(screen.getByRole("menuitem", { name: /Manual/ }));
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
  api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
    send({
      event: "done",
      result_id: 1,
      summary: { rows_affected: 1, elapsed_ms: 1, has_more: false },
    });
    return null;
  });
  useConnections.setState({
    file: { version: 1, groups: [], connections: [pg, my] },
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

describe("transaction mode", () => {
  it("is Auto-commit by default and never issues BEGIN", async () => {
    await mountConsole();
    expect(screen.getByRole("button", { name: "Tx: Auto-commit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Commit" })).toBeNull();
    await act(async () => void (await runCommand("console.run")));
    expect(sent()).toEqual(["update t set a = 1"]);
  });

  it("switches to Manual and shows Commit and Rollback", async () => {
    const { id } = await mountConsole();
    await chooseManual();
    expect(modeOf(id)).toBe("manual");
    expect(screen.getByRole("button", { name: "Tx: Manual" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rollback" })).toBeDisabled();
  });

  it("opens the transaction with the first statement and keeps it open across runs", async () => {
    const { runtime } = await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    await act(async () => void (await runCommand("console.run")));
    expect(sent()).toEqual(["BEGIN", "update t set a = 1", "update t set a = 1"]);
    expect(runtime.store.getState()).toMatchObject({ txOpen: true, txPending: 2 });
    expect(screen.getByRole("status")).toHaveTextContent("2 pending");
    expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled();
  });

  it("uses each database's own BEGIN", async () => {
    await mountConsole("select 1", "c2");
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    expect(sent()[0]).toBe("START TRANSACTION");
  });

  it("counts every statement of a script", async () => {
    api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
      for (const [i, id] of [1, 2, 3].entries()) {
        send({
          event: "done",
          result_id: id,
          summary: { rows_affected: 1, elapsed_ms: 1, has_more: false },
        });
        void i;
      }
      return null;
    });
    const { runtime } = await mountConsole(
      "update a set x=1;\nupdate b set x=1;\nupdate c set x=1",
    );
    await chooseManual();
    await act(async () => void (await runCommand("console.runScript")));
    expect(runtime.store.getState().txPending).toBe(3);
  });

  it("Commit ends the transaction and logs it", async () => {
    const { runtime } = await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Commit" })));
    expect(sent().slice(-1)[0]).toBe("COMMIT");
    expect(runtime.store.getState()).toMatchObject({ txOpen: false, txPending: 0 });
    expect(runtime.store.getState().output.slice(-1)[0].message).toBe("Committed 1 statement");
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("button", { name: "Commit" })).toBeDisabled();
  });

  it("Rollback ends it too, and the next statement starts a new transaction", async () => {
    const { runtime } = await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Rollback" })));
    expect(sent().slice(-1)[0]).toBe("ROLLBACK");
    expect(runtime.store.getState().output.slice(-1)[0].message).toBe("Rolled back 1 statement");
    await act(async () => void (await runCommand("console.run")));
    expect(sent().filter((s) => s === "BEGIN")).toHaveLength(2);
  });

  it("reports a COMMIT the server refused and keeps the transaction open", async () => {
    const { runtime } = await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    api.execute.mockRejectedValueOnce({
      code: "query_failed",
      message: "could not serialize access",
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Commit" })));
    expect(runtime.store.getState().txOpen).toBe(true);
    expect(runtime.store.getState().output.slice(-1)[0]).toMatchObject({
      kind: "error",
      message: "could not serialize access",
    });
  });

  it("forgets the transaction when the session is lost", async () => {
    const { runtime } = await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    act(() => runtime.sessionLost());
    expect(runtime.store.getState()).toMatchObject({ txOpen: false, txPending: 0 });
  });
});

describe("leaving Manual mode", () => {
  async function withOpenTransaction() {
    const ctx = await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    return ctx;
  }

  it("asks to commit or roll back first", async () => {
    const { id } = await withOpenTransaction();
    fireEvent.click(screen.getByRole("button", { name: /^Tx:/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Auto-commit/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Uncommitted transaction")).toBeInTheDocument();
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Commit" })));
    await waitFor(() => expect(modeOf(id)).toBe("auto"));
    expect(sent().slice(-1)[0]).toBe("COMMIT");
  });

  it("stays in Manual when the user cancels", async () => {
    const { id } = await withOpenTransaction();
    fireEvent.click(screen.getByRole("button", { name: /^Tx:/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Auto-commit/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(modeOf(id)).toBe("manual");
    expect(sent()).not.toContain("COMMIT");
  });

  it("switches without asking when nothing is pending", async () => {
    const { id } = await mountConsole();
    await chooseManual();
    fireEvent.click(screen.getByRole("button", { name: /^Tx:/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: /Auto-commit/ }));
    await waitFor(() => expect(modeOf(id)).toBe("auto"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("closing a console with an open transaction", () => {
  async function open() {
    const ctx = await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    return ctx;
  }
  const tabs = () => useWorkspace.getState().tabs;

  it("asks Commit / Roll back / Cancel (spec: sql-console › Close with an open transaction)", async () => {
    await open();
    act(() => useWorkspace.getState().requestClose(tabs()[0].id));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/open transaction with 1 statement/)).toBeInTheDocument();
    expect(
      within(dialog)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(expect.arrayContaining(["Cancel", "Roll back", "Commit"]));
  });

  it("Cancel keeps the console open", async () => {
    await open();
    act(() => useWorkspace.getState().requestClose(tabs()[0].id));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(tabs()).toHaveLength(1);
    expect(sent()).not.toContain("ROLLBACK");
  });

  it("Roll back rolls back, then closes the tab and its session", async () => {
    await open();
    act(() => useWorkspace.getState().requestClose(tabs()[0].id));
    await act(async () =>
      fireEvent.click(await screen.findByRole("button", { name: "Roll back" })),
    );
    await waitFor(() => expect(tabs()).toHaveLength(0));
    expect(sent().slice(-1)[0]).toBe("ROLLBACK");
    expect(api.sessionClose).toHaveBeenCalledWith("s1");
  });

  it("Commit commits, then closes", async () => {
    await open();
    act(() => useWorkspace.getState().requestClose(tabs()[0].id));
    const dialog = await screen.findByRole("dialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "Commit" })));
    await waitFor(() => expect(tabs()).toHaveLength(0));
    expect(sent().slice(-1)[0]).toBe("COMMIT");
  });

  it("closes straight away without a transaction", async () => {
    await mountConsole();
    act(() => useWorkspace.getState().requestClose(tabs()[0].id));
    await waitFor(() => expect(tabs()).toHaveLength(0));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
