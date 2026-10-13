import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import { resetUiState } from "../../lib/uiState";
import { clearCommands } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { useSlots } from "../../shell/registry/slots";
import { useStatusItems } from "../../shell/registry/statusItems";
import { clearTabKinds, registerTabKind } from "../../shell/registry/tabKinds";
import { Notices } from "../../shell/Notices";
import { StatusBar } from "../../shell/StatusBar";
import { TabStrip } from "../../shell/TabStrip";
import { useLayout } from "../../stores/layoutStore";
import { useNotices } from "../../stores/noticesStore";
import { DEFAULT_SESSION_SETTINGS, useSessionSettings } from "../../stores/sessionSettings";
import { resetSessions, useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { clearPrompts, ConsolePromptHost } from "../console/prompts";
import { registerSessionsFeature } from "./index";
import { SessionsPanel } from "./SessionsPanel";
import { meta } from "./testing";

const api = vi.hoisted(() => ({ commit: vi.fn(), rollback: vi.fn() }));
vi.mock("./api", () => ({
  sessionsSubscribe: vi.fn().mockResolvedValue(undefined),
  sessionSetMeta: vi.fn().mockResolvedValue(undefined),
  sessionCommit: (...a: unknown[]) => api.commit(...a),
  sessionRollback: (...a: unknown[]) => api.rollback(...a),
  sessionsOpenTransactions: vi.fn().mockResolvedValue([]),
}));

const T0 = 10_000_000;
const MIN = 60_000;
const prod = toConnection({
  ...newDraft("postgres", "production"),
  id: "p",
  name: "prod-postgres",
  host: "h",
});
const staging = toConnection({
  ...newDraft("postgres", "staging"),
  id: "s",
  name: "staging-pg",
  host: "h",
});
const local = toConnection({
  ...newDraft("postgres", "local"),
  id: "l",
  name: "local-pg",
  host: "h",
});

const open = (
  id: string,
  connectionId: string,
  over: Parameters<typeof meta>[0] extends infer P ? Partial<P> : never = {},
) =>
  meta({
    id,
    connectionId,
    name: id,
    state: "in_transaction",
    txStartedAt: T0,
    lastActivityAt: T0,
    txStatementCount: 1,
    ...over,
  });

let off: () => void = () => {};

beforeEach(() => {
  resetUiState();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearPrompts();
  resetSessions();
  vi.clearAllMocks();
  api.commit.mockResolvedValue(undefined);
  api.rollback.mockResolvedValue(undefined);
  useStatusItems.setState({ items: [] });
  useSlots.setState({ bottomPanel: null });
  useLayout.setState({ bottomPanelOpen: false });
  useNotices.setState({ notices: [] });
  useSessionSettings.setState({ settings: { ...DEFAULT_SESSION_SETTINGS } });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useConnections.setState({
    file: { version: 1, groups: [], connections: [prod, staging, local] },
    connected: {},
  });
  off = registerSessionsFeature();
});
afterEach(() => off());

const snapshot = (...sessions: ReturnType<typeof meta>[]) =>
  act(() => useSessions.getState().apply({ kind: "snapshot", sessions }));
const tick = (at: number) => act(() => useSessions.getState().tick(at));

describe("idle-in-transaction flag (spec: session-manager › Idle-in-transaction warnings)", () => {
  it("appears at the threshold on production (2 minutes) and not before (spec: session-manager › Threshold reached)", () => {
    snapshot(open("a", "p"));
    tick(T0 + 2 * MIN - 1000);
    expect(useSessions.getState().idle).toEqual({});
    tick(T0 + 2 * MIN);
    expect(useSessions.getState().idle).toEqual({ a: true });
  });

  it("uses 5 minutes for staging and 15 for local, and follows Settings", () => {
    snapshot(open("a", "s"), open("b", "l"));
    tick(T0 + 4 * MIN);
    expect(useSessions.getState().idle).toEqual({});
    tick(T0 + 5 * MIN);
    expect(useSessions.getState().idle).toEqual({ a: true });
    tick(T0 + 15 * MIN);
    expect(useSessions.getState().idle).toEqual({ a: true, b: true });
    act(() => useSessionSettings.getState().set({ production: 30 }));
    expect(useSessionSettings.getState().settings.production).toBe(30);
  });

  it("shows on the row, the tab and the status bar item", () => {
    registerTabKind({
      kind: "console",
      icon: () => null,
      title: () => "console",
      render: () => null,
    });
    useWorkspace.setState({
      tabs: [{ id: "t", kind: "console", key: "k", state: { connectionId: "p", sessionId: "a" } }],
      activeTabId: "t",
    });
    snapshot(open("a", "p"), open("b", "p", { txStartedAt: T0 + 1 }));
    tick(T0 + 2 * MIN);
    render(
      <>
        <TabStrip />
        <StatusBar />
        <SessionsPanel />
      </>,
    );
    const dot = screen.getByRole("img", { name: "Transaction idle" });
    expect(dot).toHaveAttribute("data-production", "true");
    expect(
      screen.getByRole("button", { name: /Sessions 2 · 2 idle in transaction/ }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("img", { name: "Idle in transaction" })).toHaveLength(2);
    // the explanation of the impact is in the details pane
    fireEvent.click(screen.getAllByRole("treeitem")[1]);
    expect(screen.getByRole("alert")).toHaveTextContent(/block other writers/);
    expect(screen.getByRole("alert")).toHaveTextContent(/on Production/);
  });

  it("clears on activity and returns after the threshold passes again (spec: session-manager › Activity resets)", () => {
    snapshot(open("a", "p"));
    tick(T0 + 2 * MIN);
    expect(useSessions.getState().idle.a).toBe(true);
    // a statement runs: the backend bumps the last activity
    act(() =>
      useSessions.getState().apply({
        kind: "upsert",
        session: open("a", "p", { lastActivityAt: T0 + 2 * MIN + 5000 }),
      }),
    );
    tick(T0 + 2 * MIN + 6000);
    expect(useSessions.getState().idle).toEqual({});
    tick(T0 + 4 * MIN + 5000);
    expect(useSessions.getState().idle.a).toBe(true);
  });
});

describe("notification (spec: session-manager › Threshold reached)", () => {
  it("fires once per transaction, with Roll back and Show", () => {
    snapshot(open("a", "p"));
    tick(T0 + 2 * MIN);
    tick(T0 + 2 * MIN + 15_000);
    tick(T0 + 3 * MIN);
    expect(useNotices.getState().notices).toHaveLength(1);
    expect(useNotices.getState().notices[0].actions?.map((a) => a.label)).toEqual([
      "Roll back",
      "Show",
    ]);
    // the transaction ends, a new one goes idle: a new notification
    act(() =>
      useSessions.getState().apply({
        kind: "upsert",
        session: meta({ id: "a", connectionId: "p", lastActivityAt: T0 + 4 * MIN }),
      }),
    );
    tick(T0 + 4 * MIN + 1000);
    act(() =>
      useSessions.getState().apply({
        kind: "upsert",
        session: open("a", "p", { txStartedAt: T0 + 5 * MIN, lastActivityAt: T0 + 5 * MIN }),
      }),
    );
    tick(T0 + 7 * MIN);
    expect(useNotices.getState().notices).toHaveLength(2);
  });

  it("is not shown for local connections: the badge only", () => {
    snapshot(open("b", "l"));
    tick(T0 + 20 * MIN);
    expect(useSessions.getState().idle.b).toBe(true);
    expect(useNotices.getState().notices).toHaveLength(0);
  });

  it("can be turned off in Settings", () => {
    act(() => useSessionSettings.getState().set({ notify: false }));
    snapshot(open("a", "p"));
    tick(T0 + 3 * MIN);
    expect(useSessions.getState().idle.a).toBe(true);
    expect(useNotices.getState().notices).toHaveLength(0);
  });

  it("Roll back rolls the session back and Show opens the panel on it", async () => {
    snapshot(open("a", "p"), open("c", "p", { txStartedAt: T0 + 1 }));
    tick(T0 + 2 * MIN);
    render(<Notices />);
    const notices = screen.getAllByRole("status");
    await act(async () =>
      fireEvent.click(within(notices[0]).getByRole("button", { name: "Roll back" })),
    );
    expect(api.rollback).toHaveBeenCalledWith("a");
    fireEvent.click(within(screen.getAllByRole("status")[0]).getByRole("button", { name: "Show" }));
    expect(useLayout.getState().bottomPanelOpen).toBe(true);
    expect(useSessions.getState().selection).toEqual({ kind: "session", id: "c" });
  });
});

describe("Roll back all idle (spec: session-manager › Roll back all idle)", () => {
  it("lists the flagged sessions and rolls both back on Confirm", async () => {
    snapshot(open("a", "p"), open("b", "p", { txStartedAt: T0 + 1 }), open("c", "l"));
    tick(T0 + 2 * MIN);
    render(
      <>
        <StatusBar />
        <ConsolePromptHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Roll back 2 idle sessions/ }));
    const dialog = within(await screen.findByRole("dialog"));
    expect(dialog.getAllByRole("listitem")).toHaveLength(2);
    expect(api.rollback).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(dialog.getByRole("button", { name: "Confirm" })));
    expect(api.rollback.mock.calls.map((c) => c[0]).sort()).toEqual(["a", "b"]);
  });

  it("does nothing when the user cancels", async () => {
    snapshot(open("a", "p"));
    tick(T0 + 2 * MIN);
    render(
      <>
        <SessionsPanel />
        <ConsolePromptHost />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: /Roll back all idle/ }));
    fireEvent.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
    );
    expect(api.rollback).not.toHaveBeenCalled();
  });
});
