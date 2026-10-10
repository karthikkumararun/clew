import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Terminal } from "../components/icons";
import App from "../App";
import { setPlatformForTests } from "../lib/platform";
import { getUiState, resetUiState } from "../lib/uiState";
import { useLayout, rehydrateLayout } from "../stores/layoutStore";
import { useNotices } from "../stores/noticesStore";
import {
  DEFAULT_SETTINGS,
  applySettingsToDocument,
  normalize,
  useSettings,
} from "../stores/settingsStore";
import { useWorkspace } from "../stores/workspaceStore";
import { clearCommands } from "./registry/commands";
import { clearShortcuts } from "./registry/shortcuts";
import { useStatusItems } from "./registry/statusItems";
import { clearTabKinds, registerTabKind } from "./registry/tabKinds";
import {
  MAX_SESSION_BYTES,
  SESSION_KEY,
  parseSession,
  persistSession,
  restoreSession,
  serializeSession,
  startSessionPersistence,
} from "./session";

const ipc = vi.hoisted(() => ({
  settingsGet: vi.fn(),
  settingsSet: vi.fn(async (s: unknown) => s),
}));
vi.mock("../lib/ipc", () => ({
  appPaths: async () => ({
    dataDir: "d",
    connectionsFile: "f",
    connectionsFileDisplay: "f",
    appVersion: "0.1.0",
  }),
  settingsGet: ipc.settingsGet,
  settingsSet: ipc.settingsSet,
  isTauri: () => false,
  tauriUiStateBackend: { load: async () => ({}), save: () => {} },
}));

interface Doc {
  name: string;
  text: string;
}

function registerDocKind() {
  registerTabKind<Doc>({
    kind: "console",
    icon: Terminal,
    title: (s) => s.name,
    render: ({ tab }) => <div data-testid="editor">{tab.state.text}</div>,
  });
}

beforeEach(() => {
  resetUiState();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  useStatusItems.setState({ items: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useSettings.setState({ settings: DEFAULT_SETTINGS, dialogOpen: false, section: "General" });
  useNotices.setState({ notices: [] });
  setPlatformForTests("mac");
  ipc.settingsGet.mockReset();
  ipc.settingsSet.mockClear();
  document.documentElement.style.removeProperty("--fs-code");
  registerDocKind();
});

const openDoc = (name: string, text: string) =>
  useWorkspace.getState().openTab<Doc>({ kind: "console", key: name, state: { name, text } });

describe("session restore", () => {
  it("reopens three console tabs in order with the same text", () => {
    openDoc("one", "select 1");
    openDoc("two", "select 2");
    const third = openDoc("three", "select 3");
    useWorkspace.getState().activateTab(third);
    persistSession();

    // relaunch
    useWorkspace.setState({ tabs: [], activeTabId: null });
    restoreSession();

    const { tabs, activeTabId } = useWorkspace.getState();
    expect(tabs.map((t) => (t.state as Doc).name)).toEqual(["one", "two", "three"]);
    expect(tabs.map((t) => (t.state as Doc).text)).toEqual(["select 1", "select 2", "select 3"]);
    expect(activeTabId).toBe(third);
  });

  it("restored tabs render without any connection being made", () => {
    openDoc("one", "select 1");
    persistSession();
    useWorkspace.setState({ tabs: [], activeTabId: null });
    restoreSession();
    render(<App />);
    expect(screen.getByTestId("editor")).toHaveTextContent("select 1");
    expect(screen.queryByTestId("welcome")).not.toBeInTheDocument();
  });

  it("uses the kind's serialize / deserialize hooks", () => {
    clearTabKinds();
    registerTabKind<Doc & { transient: number }>({
      kind: "console",
      icon: Terminal,
      title: (s) => s.name,
      render: () => null,
      serialize: ({ name, text }) => ({ name, text }),
      deserialize: (raw) => ({ ...(raw as Doc), transient: 0 }),
    });
    useWorkspace
      .getState()
      .openTab({ kind: "console", key: "k", state: { name: "n", text: "t", transient: 42 } });
    persistSession();
    expect(getUiState(SESSION_KEY)).not.toContain("transient");
    useWorkspace.setState({ tabs: [], activeTabId: null });
    restoreSession();
    expect(useWorkspace.getState().tabs[0].state).toEqual({ name: "n", text: "t", transient: 0 });
  });

  it("skips tabs of kinds that no longer exist and survives garbage", () => {
    openDoc("one", "x");
    persistSession();
    clearTabKinds();
    expect(parseSession(getUiState(SESSION_KEY)).tabs).toEqual([]);
    expect(parseSession("{ not json")).toEqual({ tabs: [], activeTabId: null });
    expect(parseSession(null)).toEqual({ tabs: [], activeTabId: null });
  });

  it("drops the largest tabs when the session exceeds the 5 MB cap", () => {
    const big = "x".repeat(MAX_SESSION_BYTES);
    openDoc("small", "select 1");
    openDoc("big", big);
    const json = serializeSession(useWorkspace.getState().tabs, null);
    const names = (JSON.parse(json).tabs as { state: Doc }[]).map((t) => t.state.name);
    expect(names).toEqual(["small"]);
  });

  it("saves 500ms after the last change", () => {
    vi.useFakeTimers();
    const stop = startSessionPersistence();
    openDoc("one", "a");
    vi.advanceTimersByTime(400);
    expect(getUiState(SESSION_KEY)).toBeNull();
    openDoc("two", "b");
    vi.advanceTimersByTime(499);
    expect(getUiState(SESSION_KEY)).toBeNull();
    vi.advanceTimersByTime(1);
    expect(parseSession(getUiState(SESSION_KEY)).tabs).toHaveLength(2);
    stop();
    vi.useRealTimers();
  });

  it("flushes immediately when the window goes away", () => {
    const stop = startSessionPersistence();
    openDoc("one", "a");
    window.dispatchEvent(new Event("pagehide"));
    expect(parseSession(getUiState(SESSION_KEY)).tabs).toHaveLength(1);
    stop();
  });
});

describe("layout restore", () => {
  it("restores sidebar visibility from persisted UI state", () => {
    const { unmount } = render(<App />);
    fireEvent.keyDown(window, { code: "KeyB", key: "b", metaKey: true });
    unmount();
    useLayout.setState({ sidebarOpen: true });
    rehydrateLayout();
    expect(useLayout.getState().sidebarOpen).toBe(false);
  });
});

describe("settings", () => {
  it("defaults match the spec", () => {
    expect(DEFAULT_SETTINGS).toEqual({
      editorFontSize: 13,
      gridPageSize: 500,
      confirmCloseUnsaved: true,
      checkForUpdates: false,
    });
  });

  it("normalizes out-of-range values", () => {
    expect(normalize({ editorFontSize: 99 }).editorFontSize).toBe(20);
    expect(normalize({ editorFontSize: 2 }).editorFontSize).toBe(11);
    expect(normalize({ gridPageSize: 7 as 100 }).gridPageSize).toBe(500);
  });

  it("Mod+, opens the dialog with all sections", () => {
    render(<App />);
    fireEvent.keyDown(window, { code: "Comma", key: ",", metaKey: true });
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const nav = within(within(dialog).getByRole("navigation", { name: "Settings sections" }));
    for (const s of ["General", "Editor", "Data grid", "Keymap", "AI assistant", "Updates"]) {
      expect(nav.getByRole("button", { name: s })).toBeInTheDocument();
    }
  });

  it("opens from the toolbar gear and closes on Escape", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("button", { name: "Settings" }));
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("changing the editor font size applies immediately and persists", async () => {
    const user = userEvent.setup();
    const stop = useSettings.subscribe((s) => applySettingsToDocument(s.settings));
    render(<App />);
    useSettings.getState().openDialog("Editor");
    const input = await screen.findByLabelText("Editor font size");
    await user.clear(input);
    await user.type(input, "15");
    expect(useSettings.getState().settings.editorFontSize).toBe(15);
    expect(document.documentElement.style.getPropertyValue("--fs-code")).toBe("15px");
    await waitFor(() => expect(ipc.settingsSet).toHaveBeenCalled());
    expect(ipc.settingsSet.mock.calls[ipc.settingsSet.mock.calls.length - 1]?.[0]).toMatchObject({
      editorFontSize: 15,
    });
    stop();
  });

  it("ignores an out-of-range font size", async () => {
    const user = userEvent.setup();
    render(<App />);
    useSettings.getState().openDialog("Editor");
    const input = await screen.findByLabelText("Editor font size");
    await user.clear(input);
    await user.type(input, "40");
    expect(useSettings.getState().settings.editorFontSize).not.toBe(40);
    fireEvent.blur(input);
    expect(input).toHaveValue(useSettings.getState().settings.editorFontSize);
  });

  it("page size, confirm-close and update-check toggles update the store", async () => {
    const user = userEvent.setup();
    render(<App />);
    useSettings.getState().openDialog("Data grid");
    await user.click(await screen.findByRole("radio", { name: "1000" }));
    expect(useSettings.getState().settings.gridPageSize).toBe(1000);

    await user.click(screen.getByRole("button", { name: "General" }));
    await user.click(screen.getByLabelText(/Confirm before closing/));
    expect(useSettings.getState().settings.confirmCloseUnsaved).toBe(false);

    await user.click(screen.getByRole("button", { name: "Updates" }));
    const check = screen.getByLabelText(/^Check for updates/);
    expect(check).not.toBeChecked();
    await user.click(check);
    expect(useSettings.getState().settings.checkForUpdates).toBe(true);
  });

  it("shows a non-blocking notice when the settings file was corrupt", async () => {
    ipc.settingsGet.mockResolvedValue({
      settings: DEFAULT_SETTINGS,
      notice: "Settings could not be read, so defaults are in use.",
    });
    render(<App />);
    await act(() => useSettings.getState().load());
    expect(await screen.findByRole("status")).toHaveTextContent("defaults are in use");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(useSettings.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults with a notice if loading fails", async () => {
    ipc.settingsGet.mockRejectedValue({ code: "x", message: "boom" });
    await useSettings.getState().load();
    expect(useNotices.getState().notices).toHaveLength(1);
    expect(useSettings.getState().settings).toEqual(DEFAULT_SETTINGS);
  });
});
