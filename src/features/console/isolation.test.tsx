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
import { resetSessions, useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import {
  OpenTransactionsHost,
  clearOpenTransactionPrompts,
} from "../sessions/OpenTransactionsDialog";
import { meta } from "../sessions/testing";
import { stubLayout } from "../explorer/testing";
import { clearSnapshots } from "./completion/snapshots";
import { registerConsoleTab } from "./ConsoleTab";
import { ConsoleToolbar } from "./ConsoleToolbar";
import { ConsoleView } from "./ConsoleView";
import { openConsole, registerConsoleCommands } from "./commands";
import { getView } from "./editor/views";
import { ConsolePromptHost, clearPrompts } from "./prompts";
import { settleTransactionsBeforeQuit } from "./quit";
import { clearRuntimes, getRuntime } from "./runtime";
import { registerConsoleStatusItems } from "./statusItems";

const api = vi.hoisted(() => ({
  execute: vi.fn(),
  sessionOpen: vi.fn(),
  setIsolation: vi.fn(),
  commit: vi.fn(),
  rollback: vi.fn(),
  openTx: vi.fn(),
}));
vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  queryExecute: (...a: unknown[]) => api.execute(...a),
  queryCancel: vi.fn(),
  queryFetchMore: vi.fn(),
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: vi.fn().mockResolvedValue(undefined),
  completionSnapshot: vi.fn().mockResolvedValue({ schemas: [] }),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("../sessions/api", () => ({
  sessionsSubscribe: vi.fn().mockResolvedValue(undefined),
  sessionSetMeta: vi.fn().mockResolvedValue(undefined),
  sessionSetIsolation: (...a: unknown[]) => api.setIsolation(...a),
  sessionCommit: (...a: unknown[]) => api.commit(...a),
  sessionRollback: (...a: unknown[]) => api.rollback(...a),
  sessionsOpenTransactions: (...a: unknown[]) => api.openTx(...a),
}));
vi.mock("../grid/ResultGrid", async () => {
  const { FakeResultGrid } = await import("../grid/testing");
  return { ResultGrid: FakeResultGrid, autoWidth: () => 100 };
});
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));

type Send = (e: ResultEvent) => void;
const sent = () => api.execute.mock.calls.map((c) => c[1].sql as string);

const pg = toConnection({ ...newDraft("postgres"), id: "c1", name: "pg", host: "h" });
const pgDefault = {
  ...toConnection({ ...newDraft("postgres"), id: "c3", name: "pg-rr", host: "h" }),
  advanced: {
    ...toConnection({ ...newDraft("postgres"), host: "h" }).advanced,
    isolation: "REPEATABLE READ",
  },
};
const lite = toConnection({ ...newDraft("sqlite"), id: "c4", name: "lite", filePath: "/tmp/x.db" });

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

async function mountConsole(connectionId = "c1") {
  const id = (await openConsole({ connectionId, sql: "update t set a = 1" }))!;
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

const txButton = () => screen.getByRole("button", { name: /^Tx:/ });

async function chooseManual() {
  fireEvent.click(txButton());
  fireEvent.click(screen.getByRole("menuitem", { name: /Manual/ }));
}

/** What the backend would publish for the session once it exists. */
const publish = (over: Parameters<typeof meta>[0] extends infer P ? Partial<P> : never = {}) =>
  act(() =>
    useSessions
      .getState()
      .apply({ kind: "upsert", session: meta({ id: "s1", connectionId: "c1", ...over }) }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearRuntimes();
  clearSnapshots();
  clearPrompts();
  clearOpenTransactionPrompts();
  resetSessions();
  setPlatformForTests("mac");
  restoreLayout = stubLayout();
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "PostgreSQL", version: "16" },
    transport: null,
  });
  api.setIsolation.mockImplementation(async (_id: string, level: string) => {
    useSessions.getState().apply({
      kind: "upsert",
      session: meta({ id: "s1", connectionId: "c1", isolation: level }),
    });
  });
  api.commit.mockResolvedValue(undefined);
  api.rollback.mockResolvedValue(undefined);
  api.openTx.mockResolvedValue([]);
  api.execute.mockImplementation(async (_s: string, _r: unknown, send: Send) => {
    send({
      event: "done",
      result_id: 1,
      summary: { rows_affected: 1, elapsed_ms: 1, has_more: false },
    });
    return null;
  });
  useConnections.setState({
    file: { version: 1, groups: [], connections: [pg, pgDefault, lite] },
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

describe("isolation level in the Tx menu (spec: sql-console › Transaction isolation level)", () => {
  it("picking a level with no transaction open applies it at once and shows it on the chip (spec: sql-console › Choose a level)", async () => {
    await mountConsole();
    await act(async () => void (await runCommand("console.run")));
    publish({ state: "idle" });
    await chooseManual();
    expect(txButton()).toHaveTextContent("Tx: Manual · READ COMMITTED");
    fireEvent.click(txButton());
    expect(screen.getByRole("menuitem", { name: /READ COMMITTED/ })).toHaveTextContent("✓");
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "SERIALIZABLE" })));
    expect(api.setIsolation).toHaveBeenCalledWith("s1", "SERIALIZABLE");
    expect(txButton()).toHaveTextContent("Tx: Manual · SERIALIZABLE");
  });

  it("applies to the next transaction: the level is set before BEGIN", async () => {
    await mountConsole();
    await chooseManual();
    fireEvent.click(txButton());
    // no session yet: the driver's levels are offered and the session opens on demand
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "REPEATABLE READ" })),
    );
    await waitFor(() => expect(api.setIsolation).toHaveBeenCalledWith("s1", "REPEATABLE READ"));
    await act(async () => void (await runCommand("console.run")));
    expect(sent()[0]).toBe("BEGIN");
    expect(api.setIsolation.mock.invocationCallOrder[0]).toBeLessThan(
      api.execute.mock.invocationCallOrder[0],
    );
  });

  it("asks to Commit, Roll back or Cancel before changing inside a transaction (spec: sql-console › Change inside a transaction)", async () => {
    await mountConsole();
    await chooseManual();
    await act(async () => void (await runCommand("console.run")));
    publish({ state: "in_transaction", txStartedAt: 1, txStatementCount: 1 });
    fireEvent.click(txButton());
    fireEvent.click(screen.getByRole("menuitem", { name: "SERIALIZABLE" }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Commit" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Roll back" })).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(api.setIsolation).not.toHaveBeenCalled();

    fireEvent.click(txButton());
    fireEvent.click(screen.getByRole("menuitem", { name: "SERIALIZABLE" }));
    const ask = within(await screen.findByRole("dialog"));
    await act(async () => fireEvent.click(ask.getByRole("button", { name: "Roll back" })));
    await waitFor(() => expect(api.setIsolation).toHaveBeenCalledWith("s1", "SERIALIZABLE"));
    expect(sent().slice(-1)[0]).toBe("ROLLBACK");
  });

  it("starts from the connection's default level (spec: sql-console › Connection default)", async () => {
    await mountConsole("c3");
    await chooseManual();
    expect(txButton()).toHaveTextContent("Tx: Manual · REPEATABLE READ");
  });

  it("offers no levels when the driver has none, and says nothing on the chip", async () => {
    await mountConsole("c4");
    await chooseManual();
    expect(txButton()).toHaveTextContent(/^Tx: Manual$/);
    fireEvent.click(txButton());
    expect(screen.getAllByRole("menuitem").map((i) => i.textContent)).toEqual([
      "Auto-commit",
      "✓ Manual",
    ]);
  });
});

describe("waiting on a shared session (spec: session-manager › Queued execution)", () => {
  it("shows Waiting for <tab> in the console status", async () => {
    const off = registerConsoleStatusItems();
    const { useStatusItems } = await import("../../shell/registry/statusItems");
    const { StatusBar } = await import("../../shell/StatusBar");
    const { id } = await mountConsole();
    useWorkspace.getState().updateTabState(id, { sessionId: "s1" });
    render(<StatusBar />);
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    publish({ waitingFor: "console" });
    expect(screen.getByText("Waiting for console")).toBeInTheDocument();
    publish({ waitingFor: null });
    expect(screen.queryByText(/Waiting for/)).toBeNull();
    off();
    useStatusItems.setState({ items: [] });
  });
});

describe("quit with open transactions (spec: session-manager › Quit with two open transactions)", () => {
  const two = () => [
    meta({
      id: "q1",
      connectionId: "c1",
      name: "console",
      state: "in_transaction",
      txStartedAt: Date.now() - 90_000,
      txStatementCount: 3,
    }),
    meta({
      id: "q2",
      connectionId: "c1",
      name: "weekly_report.sql",
      state: "in_transaction",
      txStartedAt: Date.now() - 30_000,
      txStatementCount: 1,
    }),
  ];

  it("lists both sessions in one dialog and continues only after Commit all or Roll back all", async () => {
    api.openTx.mockResolvedValue(two());
    act(() => useSessions.getState().apply({ kind: "snapshot", sessions: two() }));
    render(<OpenTransactionsHost />);
    let settled = false;
    const done = settleTransactionsBeforeQuit().then((v) => ((settled = true), v));
    const dialog = within(await screen.findByRole("dialog"));
    const items = dialog.getAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("pg");
    expect(items[0]).toHaveTextContent("console");
    expect(items[0]).toHaveTextContent("3 statements");
    expect(items[1]).toHaveTextContent("weekly_report.sql");
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(settled).toBe(false);
    for (const name of ["Commit all", "Roll back all", "Review in Sessions panel", "Cancel"])
      expect(dialog.getByRole("button", { name })).toBeInTheDocument();
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Commit all" })));
    expect(await done).toBe(true);
    expect(api.commit.mock.calls.map((c) => c[0])).toEqual(["q1", "q2"]);
  });

  it("Roll back all rolls both back", async () => {
    api.openTx.mockResolvedValue(two());
    render(<OpenTransactionsHost />);
    const done = settleTransactionsBeforeQuit();
    const dialog = within(await screen.findByRole("dialog"));
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Roll back all" })));
    expect(await done).toBe(true);
    expect(api.rollback).toHaveBeenCalledTimes(2);
  });

  it("Review in Sessions panel cancels the quit and opens the panel", async () => {
    const { useLayout } = await import("../../stores/layoutStore");
    api.openTx.mockResolvedValue(two());
    render(<OpenTransactionsHost />);
    const done = settleTransactionsBeforeQuit();
    fireEvent.click(
      await within(await screen.findByRole("dialog")).findByRole("button", {
        name: "Review in Sessions panel",
      }),
    );
    expect(await done).toBe(false);
    expect(useLayout.getState().bottomPanelOpen).toBe(true);
    expect(api.commit).not.toHaveBeenCalled();
  });
});
