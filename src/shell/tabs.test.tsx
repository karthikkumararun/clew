import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Terminal } from "../components/icons";
import App from "../App";
import { resetUiState } from "../lib/uiState";
import { setPlatformForTests } from "../lib/platform";
import { DEFAULT_SETTINGS, useSettings } from "../stores/settingsStore";
import { useWorkspace } from "../stores/workspaceStore";
import { clearCommands } from "./registry/commands";
import { clearShortcuts } from "./registry/shortcuts";
import { useStatusItems } from "./registry/statusItems";
import { clearTabKinds, registerTabKind } from "./registry/tabKinds";
import type { Environment } from "../components/Badge";

interface ConsoleState {
  name: string;
  text: string;
  saved: string;
  env?: Environment;
  saveOk?: boolean;
}

const save = vi.fn(async (tab: { state: ConsoleState }) => tab.state.saveOk !== false);

beforeEach(() => {
  resetUiState();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  useStatusItems.setState({ items: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useSettings.setState({ settings: DEFAULT_SETTINGS });
  setPlatformForTests("mac");
  save.mockClear();
  registerTabKind<ConsoleState>({
    kind: "console",
    icon: Terminal,
    title: (s) => s.name,
    subtitle: () => "prod-postgres",
    env: (s) => s.env,
    isDirty: (s) => s.text !== s.saved,
    save,
    status: () => ({
      connection: { state: "connected", name: "prod-postgres", serverVersion: "PostgreSQL 16.2" },
      right: ["Ln 7, Col 34", "UTF-8"],
    }),
    render: ({ tab }) => <div data-testid="editor">{tab.state.name}</div>,
  });
});

const open = (name: string, extra: Partial<ConsoleState> = {}, key = name) =>
  useWorkspace.getState().openTab<ConsoleState>({
    kind: "console",
    key,
    state: { name, text: "", saved: "", ...extra },
  });
const ids = () =>
  useWorkspace
    .getState()
    .tabs.map((t) => t.state as ConsoleState)
    .map((s) => s.name);
const active = () => useWorkspace.getState().activeTabId;

describe("workspaceStore", () => {
  it("focuses the existing tab instead of opening a duplicate", () => {
    const a = open("a");
    open("b");
    const again = open("a-again", {}, "a");
    expect(again).toBe(a);
    expect(useWorkspace.getState().tabs).toHaveLength(2);
    expect(active()).toBe(a);
  });

  it("closing the active tab activates its left neighbour", () => {
    open("a");
    const b = open("b");
    const c = open("c");
    expect(active()).toBe(c);
    useWorkspace.getState().closeTab(c);
    expect(active()).toBe(b);
  });

  it("closing the first tab activates the first remaining tab", () => {
    const a = open("a");
    const b = open("b");
    useWorkspace.getState().activateTab(a);
    useWorkspace.getState().closeTab(a);
    expect(active()).toBe(b);
  });

  it("closing a background tab keeps the active one", () => {
    const a = open("a");
    const b = open("b");
    useWorkspace.getState().closeTab(a);
    expect(active()).toBe(b);
  });

  it("closing the last tab leaves nothing active", () => {
    const a = open("a");
    useWorkspace.getState().closeTab(a);
    expect(active()).toBeNull();
  });

  it("reorders tabs", () => {
    open("a");
    open("b");
    const c = open("c");
    useWorkspace.getState().moveTab(c, 0);
    expect(ids()).toEqual(["c", "a", "b"]);
  });

  it("cycles tabs with activateRelative, wrapping at the ends", () => {
    const a = open("a");
    open("b");
    useWorkspace.getState().activateRelative(1);
    expect(active()).toBe(a);
    useWorkspace.getState().activateRelative(-1);
    expect(ids()[useWorkspace.getState().tabs.findIndex((t) => t.id === active())]).toBe("b");
  });

  it("closes a clean tab immediately, without a prompt", () => {
    const a = open("a");
    useWorkspace.getState().requestClose(a);
    expect(useWorkspace.getState().tabs).toHaveLength(0);
    expect(useWorkspace.getState().closeRequest).toBeNull();
  });
});

describe("dirty close prompt", () => {
  const dirty = () => open("weekly", { text: "select 1", saved: "" });

  it("asks Save / Discard / Cancel before closing a dirty tab", () => {
    render(<App />);
    act(() => void dirty());
    fireEvent.click(screen.getByRole("button", { name: "Close weekly" }));
    expect(screen.getByRole("dialog", { name: "Unsaved changes" })).toBeInTheDocument();
    for (const name of ["Save", "Discard", "Cancel"]) {
      expect(screen.getByRole("button", { name })).toBeInTheDocument();
    }
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });

  it("Cancel keeps the tab", () => {
    render(<App />);
    act(() => void dirty());
    fireEvent.click(screen.getByRole("button", { name: "Close weekly" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("Discard closes without saving", async () => {
    render(<App />);
    act(() => void dirty());
    fireEvent.click(screen.getByRole("button", { name: "Close weekly" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(0));
    expect(save).not.toHaveBeenCalled();
  });

  it("Save persists then closes", async () => {
    render(<App />);
    act(() => void dirty());
    fireEvent.click(screen.getByRole("button", { name: "Close weekly" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(0));
    expect(save).toHaveBeenCalledOnce();
  });

  it("a failed save keeps the tab open", async () => {
    render(<App />);
    act(() => void open("weekly", { text: "x", saved: "", saveOk: false }));
    fireEvent.click(screen.getByRole("button", { name: "Close weekly" }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(save).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });

  it("closes without a prompt when the confirm setting is off", () => {
    useSettings.setState({ settings: { ...DEFAULT_SETTINGS, confirmCloseUnsaved: false } });
    render(<App />);
    act(() => void dirty());
    fireEvent.click(screen.getByRole("button", { name: "Close weekly" }));
    expect(useWorkspace.getState().tabs).toHaveLength(0);
  });
});

describe("tab strip", () => {
  it("shows icon, title, subtitle, dirty marker and close button", () => {
    render(<App />);
    act(() => void open("weekly", { text: "x", saved: "" }));
    const tab = screen.getByRole("tab", { name: /weekly/ });
    expect(tab).toHaveTextContent("weekly");
    expect(tab).toHaveTextContent("prod-postgres");
    expect(screen.getByRole("img", { name: "Unsaved changes" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close weekly" })).toBeInTheDocument();
  });

  it("renders the active tab's kind", () => {
    render(<App />);
    act(() => void open("a"));
    act(() => void open("b"));
    expect(screen.getByTestId("editor")).toHaveTextContent("b");
    fireEvent.pointerDown(screen.getByRole("tab", { name: /^a/ }), { button: 0, pointerId: 1 });
    expect(screen.getByTestId("editor")).toHaveTextContent("a");
  });

  it("draws a --env-prod stripe on production tabs", () => {
    render(<App />);
    act(() => void open("orders", { env: "production" }));
    const tab = screen.getByRole("tab", { name: /orders/ });
    expect(tab).toHaveAttribute("data-env", "production");
    expect(tab.style.getPropertyValue("--stripe")).toBe("var(--env-prod)");
  });

  it("Mod+W closes the active tab and Mod+Shift+[ / ] switch tabs", () => {
    render(<App />);
    act(() => void open("a"));
    act(() => void open("b"));
    act(() => void open("c"));
    fireEvent.keyDown(window, { code: "BracketLeft", key: "{", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("editor")).toHaveTextContent("b");
    fireEvent.keyDown(window, { code: "BracketRight", key: "}", metaKey: true, shiftKey: true });
    expect(screen.getByTestId("editor")).toHaveTextContent("c");
    fireEvent.keyDown(window, { code: "KeyW", key: "w", metaKey: true });
    expect(ids()).toEqual(["a", "b"]);
    expect(screen.getByTestId("editor")).toHaveTextContent("b");
  });

  it("reorders by dragging a tab past its neighbour", () => {
    render(<App />);
    act(() => void open("a"));
    act(() => void open("b"));
    act(() => void open("c"));
    const rect = (left: number) => () =>
      ({
        left,
        right: left + 100,
        width: 100,
        top: 0,
        bottom: 36,
        height: 36,
        x: left,
        y: 0,
      }) as DOMRect;
    const tabs = screen.getAllByRole("tab");
    tabs.forEach((el, i) => (el.getBoundingClientRect = rect(i * 100)));
    fireEvent.pointerDown(tabs[2], { button: 0, clientX: 250, pointerId: 1 });
    fireEvent.pointerMove(tabs[2], { clientX: 10, pointerId: 1 });
    fireEvent.pointerUp(tabs[2], { clientX: 10, pointerId: 1 });
    expect(ids()).toEqual(["c", "a", "b"]);
  });

  it("a plain click does not reorder", () => {
    render(<App />);
    act(() => void open("a"));
    act(() => void open("b"));
    const tabs = screen.getAllByRole("tab");
    fireEvent.pointerDown(tabs[1], { button: 0, clientX: 150, pointerId: 1 });
    fireEvent.pointerUp(tabs[1], { clientX: 150, pointerId: 1 });
    expect(ids()).toEqual(["a", "b"]);
  });
});

describe("status bar follows the active tab", () => {
  it("shows connection state, server version and context items", () => {
    render(<App />);
    act(() => void open("a"));
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    expect(bar).toHaveTextContent("Connected · prod-postgres");
    expect(bar).toHaveTextContent("PostgreSQL 16.2");
    expect(bar).toHaveTextContent("Ln 7, Col 34");
  });
});
