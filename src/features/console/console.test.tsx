import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts, dispatchShortcut } from "../../shell/registry/shortcuts";
import { clearTabKinds, getTabKind } from "../../shell/registry/tabKinds";
import { parseSession, serializeSession } from "../../shell/session";
import { useWorkspace } from "../../stores/workspaceStore";
import { useExplorer } from "../explorer/explorerStore";
import { ConnectionPickerHost } from "./ConnectionPicker";
import { registerConsoleTab } from "./ConsoleTab";
import { openConsole, registerConsoleCommands } from "./commands";
import { clearRuntimes, getRuntime } from "./runtime";
import { CONSOLE_KIND, isConsoleDirty } from "./state";
import type { ConsoleState } from "./state";

const api = vi.hoisted(() => ({
  sessionOpen: vi.fn(),
  sessionClose: vi.fn(),
  switchNs: vi.fn(),
  connect: vi.fn(),
}));

vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../lib/ipc/drivers", () => ({
  sessionOpen: (...a: unknown[]) => api.sessionOpen(...a),
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("../../connections/api", () => ({
  sessionSwitchNamespace: (...a: unknown[]) => api.switchNs(...a),
}));

const prod = {
  ...toConnection({ ...newDraft("postgres"), id: "c1", name: "prod-postgres", host: "h" }),
  environment: "production" as const,
};
const dev = toConnection({ ...newDraft("postgres"), id: "c2", name: "dev-postgres", host: "h" });

const tabs = () => useWorkspace.getState().tabs;
const stateOf = (i = 0) => tabs()[i].state as ConsoleState;

let offTab: () => void = () => {};
let offCommands: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearRuntimes();
  setPlatformForTests("mac");
  api.sessionOpen.mockResolvedValue({
    sessionId: "s1",
    server: { product: "PostgreSQL", version: "16" },
    transport: null,
  });
  api.sessionClose.mockResolvedValue(undefined);
  api.switchNs.mockResolvedValue(undefined);
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useExplorer.setState({ selectedId: null });
  useConnections.setState({
    file: { version: 1, groups: [], connections: [prod, dev] },
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
});

describe("console tabs", () => {
  it("opens a console titled 'console' with the connection as subtitle and its environment stripe", async () => {
    await openConsole({ connectionId: "c1" });
    const tab = tabs()[0];
    const kind = getTabKind(CONSOLE_KIND)!;
    expect(kind.title(tab.state)).toBe("console");
    expect(kind.subtitle?.(tab.state)).toBe("prod-postgres");
    expect(kind.env?.(tab.state)).toBe("production");
    expect(useWorkspace.getState().activeTabId).toBe(tab.id);
  });

  it("every console is a new tab, with optional initial text that isn't run", async () => {
    await openConsole({ connectionId: "c1", sql: "select 1" });
    await openConsole({ connectionId: "c1" });
    expect(tabs()).toHaveLength(2);
    expect(stateOf(0).text).toBe("select 1");
    expect(api.sessionOpen).not.toHaveBeenCalled();
  });

  it("is not dirty until bound to a file whose text differs", () => {
    const base: ConsoleState = { connectionId: "c1", text: "a", txMode: "auto" };
    expect(isConsoleDirty(base)).toBe(false);
    expect(isConsoleDirty({ ...base, filePath: "/x.sql", savedText: "a" })).toBe(false);
    expect(isConsoleDirty({ ...base, filePath: "/x.sql", savedText: "b" })).toBe(true);
    const kind = getTabKind(CONSOLE_KIND)!;
    expect(kind.title({ ...base, filePath: "/work/weekly_report.sql" })).toBe("weekly_report.sql");
  });
});

describe("session lifecycle", () => {
  it("opens the session on first use, not when the tab opens, and mirrors it on the tab", async () => {
    const id = (await openConsole({ connectionId: "c1" }))!;
    expect(api.sessionOpen).not.toHaveBeenCalled();
    const sessionId = await getRuntime(id, "c1").ensureSession();
    expect(sessionId).toBe("s1");
    expect(api.sessionOpen).toHaveBeenCalledWith("c1");
    expect(useConnections.getState().connect).toHaveBeenCalledWith("c1");
    expect(stateOf().sessionId).toBe("s1");
    // Further uses share the one session.
    await getRuntime(id, "c1").ensureSession();
    expect(api.sessionOpen).toHaveBeenCalledTimes(1);
  });

  it("applies a database / schema picked before the first run", async () => {
    const id = (await openConsole({
      connectionId: "c1",
      database: "analytics",
      schema: "public",
    }))!;
    await getRuntime(id, "c1").ensureSession();
    expect(api.switchNs).toHaveBeenCalledWith("s1", { database: "analytics", schema: "public" });
  });

  it("closes the session when the tab closes", async () => {
    const id = (await openConsole({ connectionId: "c1" }))!;
    await getRuntime(id, "c1").ensureSession();
    useWorkspace.getState().closeTab(id);
    expect(api.sessionClose).toHaveBeenCalledWith("s1");
    expect(tabs()).toHaveLength(0);
  });

  it("closing a tab that never ran touches no session", async () => {
    const id = (await openConsole({ connectionId: "c1" }))!;
    useWorkspace.getState().closeTab(id);
    expect(api.sessionClose).not.toHaveBeenCalled();
  });

  it("closes a session that finished opening after the tab was closed", async () => {
    let release: (v: unknown) => void = () => {};
    api.sessionOpen.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const id = (await openConsole({ connectionId: "c1" }))!;
    const pending = getRuntime(id, "c1")
      .ensureSession()
      .catch((e: Error) => e.message);
    await waitFor(() => expect(api.sessionOpen).toHaveBeenCalled());
    useWorkspace.getState().closeTab(id);
    release({ sessionId: "late", server: {}, transport: null });
    expect(await pending).toBe("The console was closed");
    expect(api.sessionClose).toHaveBeenCalledWith("late");
  });

  it("doesn't open a session when the connection can't be made", async () => {
    useConnections.setState({ connect: vi.fn(async () => false) });
    const id = (await openConsole({ connectionId: "c1" }))!;
    await expect(getRuntime(id, "c1").ensureSession()).rejects.toThrow();
    expect(api.sessionOpen).not.toHaveBeenCalled();
  });
});

describe("restoring after a restart", () => {
  it("restores the text (even unsaved) and not the session", async () => {
    const id = (await openConsole({ connectionId: "c1", sql: "select 1" }))!;
    useWorkspace
      .getState()
      .updateTabState<Partial<ConsoleState>>(id, { text: "select 2 -- draft" });
    await getRuntime(id, "c1").ensureSession();
    const raw = serializeSession(tabs(), id);
    expect(raw).not.toContain("sessionId");

    const restored = parseSession(raw);
    expect(restored.tabs).toHaveLength(1);
    const s = restored.tabs[0].state as ConsoleState;
    expect(s).toMatchObject({ connectionId: "c1", text: "select 2 -- draft", txMode: "auto" });
    expect(s.sessionId).toBeUndefined();
  });

  it("skips a saved console whose state is unusable", () => {
    const raw = JSON.stringify({
      version: 1,
      activeTabId: "t1",
      tabs: [{ id: "t1", kind: CONSOLE_KIND, key: "k", state: { text: "no connection" } }],
    });
    expect(parseSession(raw).tabs).toEqual([]);
  });
});

describe("Mod+T", () => {
  it("opens for the connection selected in the explorer (spec: sql-console › New console)", async () => {
    useExplorer.setState({ selectedId: "c2/database:analytics" });
    expect(
      dispatchShortcut(new KeyboardEvent("keydown", { key: "t", code: "KeyT", metaKey: true })),
    ).toBe(true);
    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(stateOf().connectionId).toBe("c2");
  });

  it("uses the active tab's connection when nothing is selected", async () => {
    await openConsole({ connectionId: "c1" });
    await act(async () => void (await runCommand("console.new")));
    expect(tabs().map((t) => (t.state as ConsoleState).connectionId)).toEqual(["c1", "c1"]);
  });

  it("asks which connection first when there is no context (spec: sql-console › No connection chosen)", async () => {
    render(<ConnectionPickerHost />);
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = runCommand("console.new");
    });
    expect(tabs()).toHaveLength(0);
    fireEvent.click(await screen.findByRole("button", { name: /dev-postgres/ }));
    await done;
    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(stateOf().connectionId).toBe("c2");
  });

  it("opens nothing when the picker is dismissed", async () => {
    render(<ConnectionPickerHost />);
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = runCommand("console.new");
    });
    await screen.findByRole("dialog");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await done;
    expect(tabs()).toHaveLength(0);
  });
});
