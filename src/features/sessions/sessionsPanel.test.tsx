import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import { resetUiState } from "../../lib/uiState";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { useSlots } from "../../shell/registry/slots";
import { useStatusItems } from "../../shell/registry/statusItems";
import { clearTabKinds } from "../../shell/registry/tabKinds";
import { rehydrateLayout, useLayout } from "../../stores/layoutStore";
import { useNotices } from "../../stores/noticesStore";
import { resetSessions, useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { clearPrompts } from "../console/prompts";
import { clearOpenTransactionPrompts } from "./OpenTransactionsDialog";
import { SessionsPanel } from "./SessionsPanel";
import { SwitchSessionMenu } from "./SwitchSessionMenu";
import { meta } from "./testing";

const api = vi.hoisted(() => ({
  commit: vi.fn(),
  rollback: vi.fn(),
  close: vi.fn(),
  cancel: vi.fn(),
  closeAll: vi.fn(),
  deactivate: vi.fn(),
  setIsolation: vi.fn(),
  attach: vi.fn(),
  detach: vi.fn(),
  setMeta: vi.fn(),
  openTx: vi.fn(),
}));
vi.mock("./api", () => ({
  sessionsSubscribe: vi.fn().mockResolvedValue(undefined),
  sessionsList: vi.fn(),
  sessionSetMeta: (...a: unknown[]) => api.setMeta(...a),
  sessionCommit: (...a: unknown[]) => api.commit(...a),
  sessionRollback: (...a: unknown[]) => api.rollback(...a),
  sessionDisconnect: (...a: unknown[]) => api.close(...a),
  sessionCancel: (...a: unknown[]) => api.cancel(...a),
  sessionCloseAll: (...a: unknown[]) => api.closeAll(...a),
  connectionDeactivate: (...a: unknown[]) => api.deactivate(...a),
  sessionSetIsolation: (...a: unknown[]) => api.setIsolation(...a),
  sessionAttach: (...a: unknown[]) => api.attach(...a),
  sessionDetach: (...a: unknown[]) => api.detach(...a),
  sessionsOpenTransactions: (...a: unknown[]) => api.openTx(...a),
}));
vi.mock("../../lib/ipc/drivers", async (orig) => ({
  ...(await orig<typeof import("../../lib/ipc/drivers")>()),
  sessionOpen: vi.fn().mockResolvedValue({ sessionId: "new1", server: {}, transport: null }),
}));

const NOW = 2_000_000;
const prod = toConnection({
  ...newDraft("postgres", "production"),
  id: "c1",
  name: "prod-postgres",
  host: "db",
});
const staging = toConnection({
  ...newDraft("mysql", "staging"),
  id: "c2",
  name: "staging-mysql",
  host: "db",
});

function seed(...sessions: ReturnType<typeof meta>[]) {
  act(() => {
    useSessions.getState().apply({ kind: "snapshot", sessions });
    useSessions.getState().tick(NOW);
  });
}

function resetAll() {
  resetUiState();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearPrompts();
  clearOpenTransactionPrompts();
  resetSessions();
  useStatusItems.setState({ items: [] });
  useSlots.setState({
    slots: { toolbarLeft: [], toolbarCenter: [], toolbarRight: [], sidebar: [] },
    sidePanel: null,
    bottomPanel: null,
  });
  useLayout.setState({
    sidebarOpen: true,
    sidePanelOpen: false,
    bottomPanelOpen: false,
    narrow: false,
    overlayOpen: false,
  });
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useConnections.setState({
    file: { version: 1, groups: [], connections: [prod, staging] },
    connected: {
      c1: { server: { product: "PostgreSQL", version: "16.2" }, transport: "via SSH bastion" },
    } as never,
  });
  setPlatformForTests("mac");
  Object.defineProperty(window, "innerWidth", { value: 1440, configurable: true, writable: true });
  vi.clearAllMocks();
  api.openTx.mockResolvedValue([]);
  for (const f of [api.commit, api.rollback, api.close, api.cancel, api.closeAll, api.deactivate])
    f.mockResolvedValue(undefined);
  api.setIsolation.mockResolvedValue(undefined);
  api.attach.mockResolvedValue(undefined);
  api.setMeta.mockResolvedValue(undefined);
}

beforeEach(() => {
  resetAll();
  vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => vi.restoreAllMocks());

const row = (name: string) =>
  screen.getAllByRole("treeitem").find((r) => within(r).queryByText(name))!;

describe("session states (spec: session-manager › Session states)", () => {
  it("shows Idle, Running with the clock, and In transaction with the time and count (spec: session-manager › Running statement)", () => {
    seed(
      meta({ id: "a", name: "console" }),
      meta({
        id: "b",
        name: "weekly_report.sql",
        state: "running",
        runningSince: NOW - 12_000,
        runningStatement: "SELECT * FROM orders",
      }),
      meta({
        id: "c",
        name: "orders (table editor)",
        state: "in_transaction",
        txStartedAt: NOW - 252_000,
        lastActivityAt: NOW - 1000,
        txStatementCount: 7,
      }),
    );
    render(<SessionsPanel />);
    expect(row("console")).toHaveTextContent("Idle");
    expect(row("weekly_report.sql")).toHaveTextContent("Running 00:12");
    expect(row("weekly_report.sql")).toHaveTextContent("SELECT …");
    expect(row("orders (table editor)")).toHaveTextContent("In transaction 4:12");
    expect(row("orders (table editor)")).toHaveTextContent("7 statements");
  });

  it("shows a failed transaction and a disconnected session", () => {
    seed(
      meta({ id: "a", name: "bad", state: "aborted", txStatementCount: 1, txStartedAt: NOW }),
      meta({ id: "b", name: "gone", state: "disconnected" }),
    );
    render(<SessionsPanel />);
    expect(row("bad")).toHaveTextContent("Failed transaction");
    expect(row("bad")).toHaveTextContent("1 statement");
    expect(row("gone")).toHaveTextContent("Disconnected");
  });

  it("updates live: the row returns to Idle when the statement finishes", () => {
    seed(meta({ id: "a", state: "running", runningSince: NOW - 3000 }));
    render(<SessionsPanel />);
    expect(row("console")).toHaveTextContent("Running");
    act(() => useSessions.getState().apply({ kind: "upsert", session: meta({ id: "a" }) }));
    expect(row("console")).toHaveTextContent("Idle");
  });

  it("summarises a connection and marks one without sessions as disconnected", () => {
    useSessions.getState().markDeactivated("c2", true);
    seed(
      meta({ id: "a", name: "console" }),
      meta({ id: "b", name: "other", state: "in_transaction", txStartedAt: NOW }),
    );
    render(<SessionsPanel />);
    const conn = screen.getAllByRole("treeitem").find((r) => r.getAttribute("aria-level") === "1")!;
    expect(conn).toHaveTextContent("prod-postgres");
    expect(conn).toHaveTextContent("PRODUCTION");
    expect(conn).toHaveTextContent("2 sessions · 1 in transaction");
    expect(screen.getByText("staging-mysql").closest("[role=treeitem]")).toHaveTextContent(
      "disconnected",
    );
  });
});

describe("action enablement (spec: session-manager › Session actions)", () => {
  const toolbar = () => within(screen.getByRole("toolbar", { name: "Sessions actions" }));

  it("enables only what applies to the state", () => {
    seed(
      meta({ id: "idle", name: "idle one" }),
      meta({ id: "run", name: "running one", state: "running", runningSince: NOW }),
      meta({ id: "tx", name: "tx one", state: "in_transaction", txStartedAt: NOW }),
      meta({ id: "bad", name: "failed one", state: "aborted", txStartedAt: NOW }),
    );
    render(<SessionsPanel />);
    const expectState = (name: string, cancel: boolean, commit: boolean, rollback: boolean) => {
      fireEvent.click(row(name));
      const on = (b: string, v: boolean) =>
        v
          ? expect(toolbar().getByRole("button", { name: b })).toBeEnabled()
          : expect(toolbar().getByRole("button", { name: b })).toBeDisabled();
      on("Cancel running statement", cancel);
      on("Commit", commit);
      on("Roll back", rollback);
      expect(toolbar().getByRole("button", { name: "Close session" })).toBeEnabled();
    };
    expectState("idle one", false, false, false);
    expectState("running one", true, false, false);
    expectState("tx one", false, true, true);
    expectState("failed one", false, false, true);
  });

  it("Cancel stops the running statement", () => {
    seed(meta({ id: "run", name: "r", state: "running", runningSince: NOW }));
    render(<SessionsPanel />);
    fireEvent.click(row("r"));
    fireEvent.click(toolbar().getByRole("button", { name: "Cancel running statement" }));
    expect(api.cancel).toHaveBeenCalledWith("run");
  });

  it("Close session closes an idle one without a prompt (spec: session-manager › Close session)", async () => {
    seed(meta({ id: "a", name: "console" }));
    render(<SessionsPanel />);
    fireEvent.click(row("console"));
    await act(async () =>
      fireEvent.click(toolbar().getByRole("button", { name: "Close session" })),
    );
    expect(api.close).toHaveBeenCalledWith("a", undefined);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Commit and Roll back go through the session commands", async () => {
    seed(meta({ id: "t", name: "tx", state: "in_transaction", txStartedAt: NOW }));
    render(<SessionsPanel />);
    fireEvent.click(row("tx"));
    await act(async () => fireEvent.click(toolbar().getByRole("button", { name: "Commit" })));
    expect(api.commit).toHaveBeenCalledWith("t");
    await act(async () => fireEvent.click(toolbar().getByRole("button", { name: "Roll back" })));
    expect(api.rollback).toHaveBeenCalledWith("t");
  });

  it("Deactivate with two open transactions lists both and offers Roll back all, Commit all and Cancel (spec: session-manager › Deactivate with open transactions)", async () => {
    seed(
      meta({
        id: "a",
        name: "console",
        state: "in_transaction",
        txStartedAt: NOW - 60_000,
        txStatementCount: 2,
      }),
      meta({
        id: "b",
        name: "report.sql",
        state: "in_transaction",
        txStartedAt: NOW - 90_000,
        txStatementCount: 1,
      }),
    );
    render(
      <>
        <SessionsPanel />
        <OpenTxHost />
      </>,
    );
    fireEvent.click(screen.getAllByRole("treeitem")[0]);
    fireEvent.click(toolbar().getByRole("button", { name: "Deactivate connection" }));
    const dialog = within(await screen.findByRole("dialog"));
    const list = within(dialog.getByRole("list", { name: "Sessions in a transaction" }));
    expect(list.getAllByRole("listitem")).toHaveLength(2);
    expect(dialog.getByText("report.sql")).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Roll back all" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Commit all" })).toBeInTheDocument();
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Roll back all" })));
    expect(api.deactivate).toHaveBeenCalledWith("c1", "rollback");
    expect(useConnections.getState().connected.c1).toBeUndefined();
  });

  it("Deactivate Cancel leaves everything as it was", async () => {
    seed(meta({ id: "a", name: "console", state: "in_transaction", txStartedAt: NOW }));
    render(
      <>
        <SessionsPanel />
        <OpenTxHost />
      </>,
    );
    fireEvent.click(screen.getAllByRole("treeitem")[0]);
    fireEvent.click(toolbar().getByRole("button", { name: "Deactivate connection" }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(api.deactivate).not.toHaveBeenCalled();
  });
});

describe("filter and tree (spec: session-manager › Filter)", () => {
  it("keeps only sessions whose names match, with their connections", () => {
    seed(
      meta({ id: "a", name: "console" }),
      meta({ id: "b", name: "weekly_report.sql" }),
      meta({ id: "c", connectionId: "c2", name: "console" }),
    );
    render(<SessionsPanel />);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter sessions" }), {
      target: { value: "report" },
    });
    expect(screen.getAllByRole("treeitem")).toHaveLength(2);
    expect(screen.queryByText("staging-mysql")).toBeNull();
    expect(screen.getByText("weekly_report.sql")).toBeInTheDocument();
  });

  it("moves with the arrow keys, collapses with Left and expands with Right", () => {
    seed(meta({ id: "a", name: "one" }), meta({ id: "b", name: "two" }));
    render(<SessionsPanel />);
    const tree = screen.getByRole("tree", { name: "Sessions by connection" });
    const items = () => within(tree).getAllByRole("treeitem");
    act(() => items()[0].focus());
    fireEvent.keyDown(items()[0], { key: "ArrowDown" });
    expect(items()[1]).toHaveFocus();
    expect(items()[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(items()[1], { key: "ArrowDown" });
    expect(items()[2]).toHaveFocus();
    fireEvent.keyDown(items()[2], { key: "ArrowLeft" });
    expect(items()[0]).toHaveFocus();
    fireEvent.keyDown(items()[0], { key: "ArrowLeft" });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toHaveAttribute("aria-expanded", "false");
    fireEvent.keyDown(items()[0], { key: "ArrowRight" });
    expect(items()).toHaveLength(3);
    fireEvent.keyDown(items()[0], { key: "End" });
    expect(items()[2]).toHaveFocus();
  });
});

describe("details (spec: session-manager › Details of a transaction)", () => {
  it("shows the breakdown and the last three statements with times", () => {
    seed(
      meta({
        id: "t",
        name: "orders (table editor)",
        state: "in_transaction",
        txStartedAt: NOW - 252_000,
        lastActivityAt: NOW - 1000,
        txStatementCount: 7,
        txBreakdown: { select: 2, insert: 1, update: 3, delete: 1, other: 0 },
        txStatements: [
          { at: NOW - 5000, kind: "select", text: "SELECT 1" },
          { at: NOW - 4000, kind: "insert", text: "INSERT INTO orders VALUES (1)" },
          { at: NOW - 3000, kind: "update", text: "UPDATE orders SET status = 'shipped'" },
          { at: NOW - 2000, kind: "delete", text: "DELETE FROM orders WHERE id = 1" },
        ],
      }),
    );
    render(<SessionsPanel />);
    fireEvent.click(row("orders (table editor)"));
    const details = within(screen.getByRole("region", { name: "Session details" }));
    expect(details.getByText(/7 \(3 UPDATE, 2 SELECT, 1 INSERT, 1 DELETE\)/)).toBeInTheDocument();
    const lines = within(details.getByLabelText("Last statements"));
    expect(lines.getAllByText(/\d\d:\d\d:\d\d/)).toHaveLength(3);
    expect(lines.getByText(/DELETE FROM orders/)).toBeInTheDocument();
    expect(lines.queryByText("SELECT 1")).toBeNull();
    expect(details.getByText("28841")).toBeInTheDocument();
    expect(details.getByText(/PostgreSQL 16.2 · via SSH bastion/)).toBeInTheDocument();
  });

  it("explains why there is no isolation selector when the driver has none", () => {
    seed(
      meta({
        id: "a",
        supportedIsolation: [],
        isolation: null,
        isolationNote: "SQLite runs every transaction as serializable.",
      }),
    );
    render(<SessionsPanel />);
    fireEvent.click(row("console"));
    expect(screen.queryByRole("button", { name: /^Isolation level/ })).toBeNull();
    expect(screen.getByText("SQLite runs every transaction as serializable.")).toBeInTheDocument();
  });
});

describe("switch session (spec: session-manager › Share a session)", () => {
  it("lists its own session, each other session of the connection and New session", () => {
    seed(
      meta({ id: "a", name: "console", tabId: "t1" }),
      meta({ id: "b", name: "weekly_report.sql", tabId: "t2" }),
      meta({ id: "c", name: "console (2)", tabId: "t3" }),
      meta({ id: "d", connectionId: "c2", name: "elsewhere", tabId: "t4" }),
    );
    useWorkspace.setState({
      tabs: [
        {
          id: "t2",
          kind: "console",
          key: "k2",
          state: { connectionId: "c1", sessionId: "b", filePath: "/x/weekly_report.sql" },
        },
      ],
    });
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <SwitchSessionMenu
        session={useSessions.getState().sessions.b}
        anchor={anchor}
        onClose={() => {}}
      />,
    );
    const menu = within(screen.getByRole("menu", { name: "Attach weekly_report.sql to" }));
    expect(menu.getByText("ATTACH weekly_report.sql TO")).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: /its own session/ })).toHaveTextContent("✓");
    expect(menu.getByRole("menuitem", { name: "console" })).toBeInTheDocument();
    expect(menu.getByRole("menuitem", { name: "console (2)" })).toBeInTheDocument();
    expect(menu.queryByRole("menuitem", { name: "elsewhere" })).toBeNull();
    expect(menu.getByRole("menuitem", { name: "New session" })).toBeInTheDocument();
  });

  it("attaches the tab to the chosen session", async () => {
    seed(
      meta({ id: "a", name: "console", tabId: "t1" }),
      meta({ id: "b", name: "weekly_report.sql", tabId: "t2" }),
    );
    useWorkspace.setState({
      tabs: [
        { id: "t2", kind: "console", key: "k2", state: { connectionId: "c1", sessionId: "b" } },
      ],
    });
    const anchor = document.createElement("button");
    document.body.appendChild(anchor);
    render(
      <SwitchSessionMenu
        session={useSessions.getState().sessions.b}
        anchor={anchor}
        onClose={() => {}}
      />,
    );
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "console" })));
    expect(api.attach).toHaveBeenCalledWith("a", "t2");
    expect((useWorkspace.getState().tabs[0].state as { sessionId: string }).sessionId).toBe("a");
  });
});

// ---- the dock, the status bar item and the shortcut ------------------------------------------

import { OpenTransactionsHost as OpenTxHost } from "./OpenTransactionsDialog";

describe("panel toggle (spec: session-manager › Open the panel)", () => {
  it("Mod+Alt+S opens the panel with every connected connection expanded and the active tab's session selected", () => {
    useWorkspace.setState({
      tabs: [
        { id: "t1", kind: "console", key: "k", state: { connectionId: "c1", sessionId: "b" } },
      ],
      activeTabId: "t1",
    });
    seed(meta({ id: "a", name: "console" }), meta({ id: "b", name: "report.sql" }));
    render(<App />);
    expect(screen.queryByRole("region", { name: "Sessions" })).toBeNull();
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true, altKey: true });
    expect(screen.getByRole("region", { name: "Sessions" })).toBeInTheDocument();
    const items = within(screen.getByRole("tree", { name: "Sessions by connection" })).getAllByRole(
      "treeitem",
    );
    expect(items[0]).toHaveAttribute("aria-expanded", "true");
    expect(items.find((i) => i.getAttribute("aria-selected") === "true")).toHaveTextContent(
      "report.sql",
    );
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true, altKey: true });
    expect(screen.queryByRole("region", { name: "Sessions" })).toBeNull();
  });

  it.each([1440, 880])(
    "a hidden panel reopens from the status bar item at %i px (spec: session-manager › Hidden panel can be reopened)",
    (width) => {
      Object.defineProperty(window, "innerWidth", {
        value: width,
        configurable: true,
        writable: true,
      });
      seed(meta({ id: "a", name: "console" }));
      render(<App />);
      expect(useLayout.getState().bottomPanelOpen).toBe(false);
      const item = within(screen.getByRole("contentinfo", { name: "Status bar" })).getByRole(
        "button",
        { name: /^Sessions 1/ },
      );
      fireEvent.click(item);
      expect(screen.getByRole("region", { name: "Sessions" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Hide panel" }));
      expect(screen.queryByRole("region", { name: "Sessions" })).toBeNull();
      fireEvent.click(item);
      expect(screen.getByRole("region", { name: "Sessions" })).toBeInTheDocument();
    },
  );

  it("restores visibility and height after a restart", () => {
    const first = render(<App />);
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true, altKey: true });
    const handle = () => screen.getByRole("separator", { name: "Resize Sessions" });
    const before = Number(handle().getAttribute("aria-valuenow"));
    fireEvent.keyDown(handle(), { key: "ArrowUp" });
    expect(Number(handle().getAttribute("aria-valuenow"))).toBe(before + 16);
    first.unmount();
    // a restart: the layout store is rebuilt from the persisted UI state
    useLayout.setState({ bottomPanelOpen: false });
    rehydrateLayout();
    render(<App />);
    expect(screen.getByRole("region", { name: "Sessions" })).toBeInTheDocument();
    expect(Number(handle().getAttribute("aria-valuenow"))).toBe(before + 16);
  });

  it("offers a palette command", async () => {
    const { listCommands } = await import("../../shell/registry/commands");
    render(<App />);
    expect(
      listCommands().some((c) => c.id === "sessions.toggle" && c.shortcut === "Mod+Alt+S"),
    ).toBe(true);
  });
});
