import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConnections } from "../../connections/connectionsStore";
import { newDraft, toConnection } from "../../connections/draft";
import { setPlatformForTests } from "../../lib/platform";
import { clearCommands, runCommand } from "../../shell/registry/commands";
import { clearShortcuts, dispatchShortcut } from "../../shell/registry/shortcuts";
import { useStatusItems } from "../../shell/registry/statusItems";
import { clearTabKinds, getTabKind } from "../../shell/registry/tabKinds";
import { StatusBar } from "../../shell/StatusBar";
import { UnsavedChangesDialog } from "../../shell/UnsavedChangesDialog";
import { useNotices } from "../../stores/noticesStore";
import { isTabDirty, useWorkspace } from "../../stores/workspaceStore";
import { useExplorer } from "../explorer/explorerStore";
import { ConnectionPickerHost } from "./ConnectionPicker";
import { registerConsoleTab } from "./ConsoleTab";
import { openConsole, registerConsoleCommands } from "./commands";
import { handleExternalChange } from "./fileSync";
import { ConsolePromptHost, clearPrompts } from "./prompts";
import { clearRuntimes } from "./runtime";
import { CONSOLE_KIND } from "./state";
import type { ConsoleState } from "./state";
import { useConsoleUi } from "./ui";

const api = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  read: vi.fn(),
  write: vi.fn(),
  watch: vi.fn(),
  unwatch: vi.fn(),
  sessionClose: vi.fn(),
}));

vi.mock("./fileIpc", () => ({
  fileOpenDialog: () => api.open(),
  fileSaveDialog: (...a: unknown[]) => api.save(...a),
  fileRead: (p: string) => api.read(p),
  fileWrite: (...a: unknown[]) => api.write(...a),
  fileWatch: (p: string) => api.watch(p),
  fileUnwatch: (p: string) => api.unwatch(p),
  onFileChanged: async () => () => {},
}));
vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../lib/ipc/drivers", () => ({
  DEFAULT_PAGE_SIZE: 500,
  sessionClose: (...a: unknown[]) => api.sessionClose(...a),
  sessionOpen: vi.fn(),
  queryExecute: vi.fn(),
  queryCancel: vi.fn(),
  queryFetchMore: vi.fn(),
  completionSnapshot: vi.fn(),
  introspectChildren: vi.fn(),
  isAppError: () => false,
}));
vi.mock("../../connections/api", () => ({ sessionSwitchNamespace: vi.fn() }));

const pg = toConnection({ ...newDraft("postgres"), id: "c1", name: "pg", host: "h" });
const lite = toConnection({ ...newDraft("sqlite"), id: "c2", name: "lite" });
const FILE = "/work/weekly_report.sql";
const opened = (text = "select 1", path = FILE) => ({ path, text, mtimeMs: 1 });

const tabs = () => useWorkspace.getState().tabs;
const state = (i = 0) => tabs()[i].state as ConsoleState;

let offTab: () => void = () => {};
let offCommands: () => void = () => {};

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  clearRuntimes();
  clearPrompts();
  setPlatformForTests("mac");
  useStatusItems.setState({ items: [] });
  useNotices.setState({ notices: [] });
  useConsoleUi.setState({ cursor: {} });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useExplorer.setState({ selectedId: null });
  api.watch.mockResolvedValue(undefined);
  api.unwatch.mockResolvedValue(undefined);
  api.write.mockResolvedValue(2);
  api.sessionClose.mockResolvedValue(undefined);
  useConnections.setState({
    file: { version: 1, groups: [], connections: [pg, lite] },
    connected: {},
    busy: {},
  });
  offTab = registerConsoleTab();
  offCommands = registerConsoleCommands();
});
afterEach(() => {
  offTab();
  offCommands();
});

describe("opening files", () => {
  it("opens a picked file in a console bound to it, titled with the file name", async () => {
    api.open.mockResolvedValue(opened("select 42"));
    await openConsole({ connectionId: "c1" }); // gives the file a connection in context
    await act(async () => void (await runCommand("console.openFile")));
    expect(tabs()).toHaveLength(2);
    expect(state(1)).toMatchObject({
      connectionId: "c1",
      filePath: FILE,
      text: "select 42",
      savedText: "select 42",
    });
    const kind = getTabKind(CONSOLE_KIND)!;
    expect(kind.title(state(1))).toBe("weekly_report.sql");
    expect(kind.subtitle?.(state(1))).toBeUndefined();
    expect(isTabDirty(tabs()[1])).toBe(false);
  });

  it("asks which connection when none is in context", async () => {
    api.open.mockResolvedValue(opened());
    render(<ConnectionPickerHost />);
    let done: Promise<boolean> = Promise.resolve(false);
    act(() => {
      done = runCommand("console.openFile");
    });
    fireEvent.click(await screen.findByRole("button", { name: /lite/ }));
    await act(async () => void (await done));
    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(state().connectionId).toBe("c2");
  });

  it("does nothing when the dialog is cancelled", async () => {
    api.open.mockResolvedValue(null);
    await act(async () => void (await runCommand("console.openFile")));
    expect(tabs()).toHaveLength(0);
  });

  it("focuses the console that already has the file", async () => {
    api.open.mockResolvedValue(opened());
    await openConsole({ connectionId: "c1" });
    await act(async () => void (await runCommand("console.openFile")));
    await openConsole({ connectionId: "c1" });
    await act(async () => void (await runCommand("console.openFile")));
    expect(tabs().filter((t) => (t.state as ConsoleState).filePath === FILE)).toHaveLength(1);
    expect(useWorkspace.getState().activeTabId).toBe(tabs()[1].id);
  });

  it("opens a Scripts-folder file bound to its connection (script.open)", async () => {
    api.read.mockResolvedValue(opened("select 7", "/s/analytics/monthly.sql"));
    await act(
      async () =>
        void (await runCommand("script.open", {
          connectionId: "c2",
          path: "/s/analytics/monthly.sql",
        })),
    );
    expect(api.read).toHaveBeenCalledWith("/s/analytics/monthly.sql");
    expect(state()).toMatchObject({
      connectionId: "c2",
      filePath: "/s/analytics/monthly.sql",
      text: "select 7",
    });
  });

  it("says so when the file can't be read", async () => {
    api.read.mockRejectedValue({ code: "not_found", message: "That file no longer exists" });
    await act(
      async () =>
        void (await runCommand("script.open", { connectionId: "c2", path: "/s/gone.sql" })),
    );
    expect(tabs()).toHaveLength(0);
    expect(useNotices.getState().notices[0].message).toBe(
      "Couldn't open gone.sql: That file no longer exists",
    );
  });

  it("binds Mod+O to SQL files inside an editor (elsewhere it stays 'open a database')", async () => {
    api.open.mockResolvedValue(opened());
    await openConsole({ connectionId: "c1" });
    const inEditor = document.createElement("div");
    inEditor.setAttribute("data-shortcut-scope", "editor");
    document.body.append(inEditor);
    const keydown = (target: EventTarget) => {
      const e = new KeyboardEvent("keydown", {
        key: "o",
        code: "KeyO",
        metaKey: true,
        bubbles: true,
      });
      Object.defineProperty(e, "target", { value: target });
      return dispatchShortcut(e);
    };
    expect(keydown(inEditor)).toBe(true);
    await waitFor(() => expect(api.open).toHaveBeenCalledTimes(1));
    // Outside an editor nothing in this build claims Mod+O (the connection commands own it).
    expect(keydown(document.body)).toBe(false);
    inEditor.remove();
  });
});

describe("saving", () => {
  async function fileConsole() {
    api.open.mockResolvedValue(opened("select 1"));
    await openConsole({ connectionId: "c1" });
    await act(async () => void (await runCommand("console.openFile")));
    return tabs()[1].id;
  }
  const edit = (id: string, text: string) =>
    act(() => useWorkspace.getState().updateTabState<Partial<ConsoleState>>(id, { text }));

  it("shows a dirty state once the text differs from the file", async () => {
    const id = await fileConsole();
    expect(isTabDirty(tabs()[1])).toBe(false);
    edit(id, "select 2");
    expect(isTabDirty(tabs()[1])).toBe(true);
    edit(id, "select 1");
    expect(isTabDirty(tabs()[1])).toBe(false);
  });

  it("Save writes the file and clears the dirty state", async () => {
    const id = await fileConsole();
    edit(id, "select 2");
    await act(async () => void (await runCommand("console.save")));
    expect(api.write).toHaveBeenCalledWith(FILE, "select 2");
    expect(state(1).savedText).toBe("select 2");
    expect(isTabDirty(tabs()[1])).toBe(false);
  });

  it("keeps the dirty state when the write fails", async () => {
    const id = await fileConsole();
    edit(id, "select 2");
    api.write.mockRejectedValueOnce({ code: "io", message: "Couldn't save the file" });
    await act(async () => void (await runCommand("console.save")));
    expect(isTabDirty(tabs()[1])).toBe(true);
    expect(useNotices.getState().notices[0].message).toBe(
      "Couldn't save weekly_report.sql: Couldn't save the file",
    );
  });

  it("Save on an unsaved console asks where, then binds it to the file", async () => {
    const id = (await openConsole({ connectionId: "c1", sql: "select 9" }))!;
    api.save.mockResolvedValue("/work/new_report.sql");
    await act(async () => void (await runCommand("console.save")));
    expect(api.save).toHaveBeenCalledWith("c1", "script.sql", "select 9");
    expect(state()).toMatchObject({ filePath: "/work/new_report.sql", savedText: "select 9" });
    expect(getTabKind(CONSOLE_KIND)!.title(state())).toBe("new_report.sql");
    expect(isTabDirty(tabs().find((t) => t.id === id)!)).toBe(false);
  });

  it("stays unbound when the Save dialog is cancelled", async () => {
    await openConsole({ connectionId: "c1", sql: "select 9" });
    api.save.mockResolvedValue(null);
    await act(async () => void (await runCommand("console.save")));
    expect(state().filePath).toBeUndefined();
  });

  it("Save As offers the current file name and rebinds the console", async () => {
    const id = await fileConsole();
    edit(id, "select 3");
    api.save.mockResolvedValue("/work/copy.sql");
    await act(async () => void (await runCommand("console.saveAs")));
    expect(api.save).toHaveBeenCalledWith("c1", "weekly_report.sql", "select 3");
    expect(state(1)).toMatchObject({ filePath: "/work/copy.sql", savedText: "select 3" });
  });

  it("closing a dirty file console offers Save, which writes it", async () => {
    const id = await fileConsole();
    edit(id, "select 2");
    render(<UnsavedChangesDialog />);
    act(() => useWorkspace.getState().requestClose(id));
    fireEvent.click(await screen.findByRole("button", { name: "Save" }));
    await waitFor(() => expect(tabs()).toHaveLength(1));
    expect(api.write).toHaveBeenCalledWith(FILE, "select 2");
  });

  it("never prompts to close an unsaved scratch console (its text is restored anyway)", async () => {
    const id = (await openConsole({ connectionId: "c1", sql: "scratch work" }))!;
    act(() => useWorkspace.getState().requestClose(id));
    await waitFor(() => expect(tabs()).toHaveLength(0));
  });
});

describe("file changes on disk", () => {
  async function fileConsole(text = "select 1") {
    api.open.mockResolvedValue(opened(text));
    await openConsole({ connectionId: "c1" });
    await act(async () => void (await runCommand("console.openFile")));
    return tabs()[1].id;
  }
  const edit = (id: string, text: string) =>
    act(() => useWorkspace.getState().updateTabState<Partial<ConsoleState>>(id, { text }));

  it("reloads a console without unsaved edits", async () => {
    await fileConsole();
    api.read.mockResolvedValue(opened("select 1 -- edited elsewhere"));
    await act(async () => handleExternalChange(FILE));
    expect(state(1)).toMatchObject({
      text: "select 1 -- edited elsewhere",
      savedText: "select 1 -- edited elsewhere",
    });
    expect(useNotices.getState().notices[0].message).toBe("Reloaded weekly_report.sql from disk");
  });

  it("ignores the echo of its own save", async () => {
    const id = await fileConsole();
    edit(id, "select 2");
    await act(async () => void (await runCommand("console.save")));
    api.read.mockResolvedValue(opened("select 2"));
    await act(async () => handleExternalChange(FILE));
    expect(state(1).text).toBe("select 2");
    expect(useNotices.getState().notices).toHaveLength(0);
  });

  it("asks which version to keep when there are unsaved edits", async () => {
    const id = await fileConsole();
    edit(id, "select 2 -- mine");
    api.read.mockResolvedValue(opened("select 1 -- theirs"));
    render(<ConsolePromptHost />);
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = handleExternalChange(FILE);
    });
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("File changed on disk")).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Load from disk" }));
    await act(async () => done);
    expect(state(1)).toMatchObject({ text: "select 1 -- theirs", savedText: "select 1 -- theirs" });
  });

  it("keeping my version leaves the edits, still dirty against the new file", async () => {
    const id = await fileConsole();
    edit(id, "select 2 -- mine");
    api.read.mockResolvedValue(opened("select 1 -- theirs"));
    render(<ConsolePromptHost />);
    let done: Promise<void> = Promise.resolve();
    act(() => {
      done = handleExternalChange(FILE);
    });
    fireEvent.click(await screen.findByRole("button", { name: "Keep my version" }));
    await act(async () => done);
    expect(state(1)).toMatchObject({ text: "select 2 -- mine", savedText: "select 1 -- theirs" });
    expect(isTabDirty(tabs()[1])).toBe(true);
  });

  it("just updates the baseline when the edits already match the new file", async () => {
    const id = await fileConsole();
    edit(id, "select 5");
    api.read.mockResolvedValue(opened("select 5"));
    await act(async () => handleExternalChange(FILE));
    expect(state(1)).toMatchObject({ text: "select 5", savedText: "select 5" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("tells the user when the file was deleted and keeps the text", async () => {
    await fileConsole();
    api.read.mockRejectedValue({ code: "not_found", message: "That file no longer exists" });
    await act(async () => handleExternalChange(FILE));
    expect(useNotices.getState().notices[0].message).toBe("weekly_report.sql was deleted on disk");
    expect(state(1).text).toBe("select 1");
  });
});

describe("status bar items", () => {
  it("shows cursor, encoding, dialect and transaction state for the active console", async () => {
    const id = (await openConsole({ connectionId: "c1" }))!;
    render(<StatusBar />);
    expect(screen.getByText("Ln 1, Col 1")).toBeInTheDocument();
    expect(screen.getByText("UTF-8")).toBeInTheDocument();
    expect(screen.getByText("SQL · PostgreSQL dialect")).toBeInTheDocument();
    expect(screen.getByText("Auto-commit")).toBeInTheDocument();

    act(() => useConsoleUi.getState().setCursor(id, 7, 34));
    expect(screen.getByText("Ln 7, Col 34")).toBeInTheDocument();

    act(() =>
      useWorkspace.getState().updateTabState<Partial<ConsoleState>>(id, { txMode: "manual" }),
    );
    expect(screen.getByText("Manual · no transaction")).toBeInTheDocument();
  });

  it("shows none of them for other tabs", async () => {
    useWorkspace.setState({
      tabs: [{ id: "x", kind: "other", key: "x", state: {} }],
      activeTabId: "x",
    });
    render(<StatusBar />);
    expect(screen.queryByText("UTF-8")).toBeNull();
    expect(screen.queryByText(/dialect/)).toBeNull();
  });

  it("uses each connection's dialect", async () => {
    await openConsole({ connectionId: "c2" });
    render(<StatusBar />);
    expect(screen.getByText("SQL · SQLite dialect")).toBeInTheDocument();
  });
});
