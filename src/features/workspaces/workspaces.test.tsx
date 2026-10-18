import { beforeEach, describe, expect, it, vi } from "vitest";
import { Terminal } from "../../components/icons";
import type { Environment } from "../../components/Badge";
import { useConnections } from "../../connections/connectionsStore";
import { getUiState, resetUiState } from "../../lib/uiState";
import { clearCommands } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { clearTabKinds, registerTabKind } from "../../shell/registry/tabKinds";
import { persistSession, restoreSession, serializeSession, SESSION_KEY } from "../../shell/session";
import { useWorkspace } from "../../stores/workspaceStore";
import { ENV_LABEL, environmentOf, groupByEnvironment, readBlob, tabsOf, LAST_ID } from "./model";
import {
  duplicate,
  newWorkspace,
  openConnectionWorkspace,
  remove,
  rename,
  saveAs,
  startWorkspaces,
  switchTo,
  useWorkspaces,
  workspaceRows,
} from "./store";

const mocks = vi.hoisted(() => ({
  ask: vi.fn(),
  openConsole: vi.fn(async (_args?: unknown) => "t"),
  save: vi.fn(async () => true),
  confirmClose: vi.fn(async () => true),
  onClose: vi.fn(),
}));
vi.mock("../console/prompts", () => ({ askChoice: (p: unknown) => mocks.ask(p) }));
vi.mock("../console/commands", () => ({ openConsole: (a: unknown) => mocks.openConsole(a) }));

interface Doc {
  connectionId: string;
  text: string;
  filePath?: string;
  savedText?: string;
}

/** Environment of each connection id, changed by tests like an edited connection. */
const envOf: Record<string, Environment> = {};

function registerFakeConsole() {
  registerTabKind<Doc>({
    kind: "console",
    icon: Terminal,
    title: (s) => s.filePath ?? "console",
    env: (s) => envOf[s.connectionId],
    isDirty: (s) => s.filePath !== undefined && s.text !== s.savedText,
    save: mocks.save,
    confirmClose: mocks.confirmClose,
    onClose: mocks.onClose,
    render: () => null,
  });
}

const open = (conn: string, text: string, extra: Partial<Doc> = {}) =>
  useWorkspace.getState().openTab<Doc>({
    kind: "console",
    key: `${conn}:${text}:${Math.random()}`,
    state: { connectionId: conn, text, ...extra },
  });
const texts = () => useWorkspace.getState().tabs.map((t) => (t.state as Doc).text);

let stop: () => void = () => {};
beforeEach(() => {
  stop();
  resetUiState();
  clearShortcuts();
  clearCommands();
  clearTabKinds();
  registerFakeConsole();
  for (const k of Object.keys(envOf)) delete envOf[k];
  Object.assign(envOf, { local1: "local", stg1: "staging", prod1: "production", stg2: "staging" });
  mocks.ask.mockReset();
  mocks.openConsole.mockClear();
  mocks.save.mockClear();
  mocks.save.mockResolvedValue(true);
  mocks.confirmClose.mockClear();
  mocks.confirmClose.mockResolvedValue(true);
  mocks.onClose.mockClear();
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useConnections.setState({
    file: {
      connections: ["local1", "stg1", "prod1", "stg2"].map((id) => ({
        id,
        name: `${id}-db`,
      })),
      groups: [],
    } as never,
  });
  useWorkspaces.setState({ menuOpen: false, manageOpen: false, saveAsOpen: false });
  stop = startWorkspaces();
});

describe("workspace model (spec: workspaces › Workspace model)", () => {
  it("saves the open tabs under a name and keeps working in it", () => {
    open("stg1", "select 1");
    open("stg1", "select 2");
    const r = saveAs("Release checklist");
    expect(r.ok).toBe(true);
    const active = useWorkspaces.getState().activeId;
    expect(active).not.toBe(LAST_ID);
    expect(tabsOf(active).tabs.map((t) => (t.state as Doc).text)).toEqual(["select 1", "select 2"]);
    expect(workspaceRows().find((x) => x.meta.id === active)?.meta.name).toBe("Release checklist");
  });

  it("stores connection ids and text only, never credentials or results", () => {
    open("prod1", "select secret_free");
    saveAs("Prod");
    const raw = readBlob(useWorkspaces.getState().activeId) ?? "";
    expect(raw).toContain("prod1");
    expect(raw).not.toMatch(/password|passphrase|apiKey/i);
  });

  it("refuses empty and duplicate names", () => {
    expect(saveAs("  ")).toEqual({ ok: false, error: "Enter a name" });
    saveAs("A");
    expect(saveAs("a").ok).toBe(false);
  });
});

describe("default workspace per connection (spec: workspaces › Default workspace per connection)", () => {
  it("reopens a connection's consoles after they were closed", async () => {
    open("stg1", "select a");
    open("stg1", "select b");
    open("prod1", "select p");
    persistSession();
    useWorkspace.setState({ tabs: [], activeTabId: null });
    persistSession(); // closing everything must not erase the defaults
    await openConnectionWorkspace("stg1");
    expect(texts()).toEqual(["select a", "select b"]);
  });

  it("opens one empty console for a connection that never had one", async () => {
    await openConnectionWorkspace("stg2");
    expect(mocks.openConsole).toHaveBeenCalledWith({ connectionId: "stg2" });
  });

  it("names connection defaults after the connection", () => {
    open("stg1", "select 1");
    persistSession();
    const names = workspaceRows().map((r) => r.meta.name);
    expect(names).toContain("stg1-db");
  });
});

describe("environment grouping (spec: workspaces › Environment grouping)", () => {
  it("groups by environment and puts workspaces spanning several in Mixed", () => {
    open("local1", "select 1");
    open("stg1", "select 2");
    open("prod1", "select 3");
    open("stg1", "select 4");
    open("prod1", "select 5");
    persistSession();
    const groups = groupByEnvironment(workspaceRows()).map((g) => [
      g.env,
      g.rows.map((r) => r.meta.name),
    ]);
    expect(groups).toEqual([
      ["local", ["local1-db"]],
      ["staging", ["stg1-db"]],
      ["production", ["prod1-db"]],
      ["mixed", ["Last session"]],
    ]);
    expect(ENV_LABEL.mixed).toBe("Mixed");
  });

  it("follows a connection whose environment is edited", () => {
    open("stg1", "select 1");
    persistSession();
    expect(workspaceRows().find((r) => r.meta.name === "stg1-db")?.env).toBe("staging");
    envOf.stg1 = "production";
    expect(workspaceRows().find((r) => r.meta.name === "stg1-db")?.env).toBe("production");
  });

  it("is mixed when no console has a known environment", () => {
    expect(environmentOf([])).toBe("mixed");
  });
});

describe("switching (spec: workspaces › Switching workspaces)", () => {
  const twoWorkspaces = () => {
    open("stg1", "A text");
    saveAs("A");
    const a = useWorkspaces.getState().activeId;
    useWorkspace.setState({ tabs: [], activeTabId: null });
    open("prod1", "B text");
    saveAs("B");
    return { a, b: useWorkspaces.getState().activeId };
  };

  it("keeps the work: edits in A survive a switch to B and back", async () => {
    const { a, b } = twoWorkspaces();
    await switchTo(a);
    useWorkspace
      .getState()
      .updateTabState<Doc>(useWorkspace.getState().tabs[0].id, { text: "A edited" });
    expect(await switchTo(b)).toBe(true);
    expect(texts()).toEqual(["B text"]);
    await switchTo(a);
    expect(texts()).toEqual(["A edited"]);
  });

  it("releases the tabs it leaves", async () => {
    const { a } = twoWorkspaces();
    await switchTo(a);
    expect(mocks.onClose).toHaveBeenCalledTimes(1);
  });

  it("asks about a console with an open transaction; cancelling leaves everything as it was", async () => {
    const { a } = twoWorkspaces();
    mocks.confirmClose.mockResolvedValue(false);
    expect(await switchTo(a)).toBe(false);
    expect(texts()).toEqual(["B text"]);
    expect(useWorkspaces.getState().activeId).not.toBe(a);
  });

  it("asks Save, Discard or Cancel for unsaved file changes", async () => {
    open("stg1", "edited", { filePath: "/s/report.sql", savedText: "orig" });
    saveAs("Files");
    const files = useWorkspaces.getState().activeId;
    mocks.ask.mockResolvedValueOnce("save");
    await switchTo(LAST_ID); // leaves Files, whose tab has unsaved changes
    mocks.ask.mockReset();
    // The last session still holds the tab it had before "Save as": settle it too.
    mocks.ask.mockResolvedValueOnce("save");
    await switchTo(files);
    expect(useWorkspaces.getState().activeId).toBe(files);
    expect(texts()).toEqual(["edited"]);
    mocks.ask.mockReset();

    mocks.ask.mockResolvedValueOnce("cancel");
    expect(await switchTo(LAST_ID)).toBe(false);
    expect(texts()).toEqual(["edited"]);
    expect(useWorkspaces.getState().activeId).toBe(files);
    expect(mocks.ask).toHaveBeenCalledTimes(1);

    mocks.save.mockClear();
    mocks.ask.mockResolvedValueOnce("save");
    expect(await switchTo(LAST_ID)).toBe(true);
    expect(mocks.save).toHaveBeenCalled();
  });

  it("discarding returns the file console to what the file holds", async () => {
    open("stg1", "edited", { filePath: "/s/report.sql", savedText: "orig" });
    saveAs("Files");
    const files = useWorkspaces.getState().activeId;
    mocks.ask.mockResolvedValueOnce("discard");
    expect(await switchTo(LAST_ID)).toBe(true);
    mocks.ask.mockResolvedValueOnce("discard");
    await switchTo(files);
    expect(texts()).toEqual(["orig"]);
  });
});

describe("safe restore (spec: workspaces › Safe restore)", () => {
  it("restoring opens tabs and runs and connects nothing", async () => {
    open("prod1", "DELETE FROM orders");
    saveAs("Danger");
    const id = useWorkspaces.getState().activeId;
    await switchTo(LAST_ID);
    mocks.openConsole.mockClear();
    await switchTo(id);
    expect(texts()).toEqual(["DELETE FROM orders"]);
    expect(mocks.openConsole).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });
});

describe("starting a workspace (spec: workspaces › Starting a workspace)", () => {
  it("opens an empty workspace and leaves the one it came from as it was", async () => {
    open("stg1", "staging text");
    saveAs("Staging");
    const staging = useWorkspaces.getState().activeId;
    const r = await newWorkspace("Production");
    expect(r.ok).toBe(true);
    expect(texts()).toEqual([]);
    expect(useWorkspaces.getState().activeId).not.toBe(staging);
    open("prod1", "prod text");
    persistSession();
    expect((tabsOf(staging).tabs[0].state as Doc).text).toBe("staging text");
    expect(tabsOf(staging).tabs).toHaveLength(1);
  });

  it("settles unsaved work first and stays put when cancelled", async () => {
    open("stg1", "edited", { filePath: "/s/a.sql", savedText: "orig" });
    mocks.ask.mockResolvedValueOnce("cancel");
    const r = await newWorkspace("Other");
    expect(r.ok).toBe(false);
    expect(texts()).toEqual(["edited"]);
    expect(workspaceRows().some((x) => x.meta.name === "Other")).toBe(false);
  });

  it("refuses a name that is taken", async () => {
    saveAs("Taken");
    expect((await newWorkspace("taken")).ok).toBe(false);
  });
});

describe("managing (spec: workspaces › Managing workspaces)", () => {
  it("duplicates into an independent copy", () => {
    open("stg1", "one");
    saveAs("Release checklist");
    const original = useWorkspaces.getState().activeId;
    const copy = duplicate(original);
    expect(copy.ok).toBe(true);
    if (!copy.ok) return;
    const name = workspaceRows().find((r) => r.meta.id === copy.id)?.meta.name;
    expect(name).toBe("Release checklist copy");
    useWorkspace
      .getState()
      .updateTabState<Doc>(useWorkspace.getState().tabs[0].id, { text: "two" });
    persistSession();
    expect((tabsOf(copy.id).tabs[0].state as Doc).text).toBe("one");
  });

  it("renames; the last session can't be renamed or deleted", () => {
    open("stg1", "one");
    saveAs("Old");
    const id = useWorkspaces.getState().activeId;
    expect(rename(id, "New").ok).toBe(true);
    expect(workspaceRows().some((r) => r.meta.name === "New")).toBe(true);
    expect(rename(LAST_ID, "x").ok).toBe(false);
    expect(remove(LAST_ID)).toBe(false);
  });

  it("deleting the open workspace keeps its tabs open as the last session", () => {
    open("stg1", "keep me");
    saveAs("Temp");
    const id = useWorkspaces.getState().activeId;
    expect(remove(id)).toBe(true);
    expect(useWorkspaces.getState().activeId).toBe(LAST_ID);
    expect(texts()).toEqual(["keep me"]);
    expect(tabsOf(LAST_ID).tabs).toHaveLength(1);
    expect(workspaceRows().some((r) => r.meta.id === id)).toBe(false);
  });
});

describe("last session and restart (spec: workspaces › Managing workspaces; workspaces › Migration; app-shell › Persisted workspace state)", () => {
  it("a tab list saved before workspaces existed is the last session", () => {
    const old = serializeSession(
      [
        { id: "a", kind: "console", key: "k1", state: { connectionId: "stg1", text: "one" } },
        { id: "b", kind: "console", key: "k2", state: { connectionId: "stg1", text: "two" } },
        { id: "c", kind: "console", key: "k3", state: { connectionId: "stg1", text: "three" } },
      ],
      "b",
    );
    resetUiState();
    stop();
    // what an older version wrote, under the key it always used
    localStorage.setItem(`clew:${SESSION_KEY}`, old);
    stop = startWorkspaces();
    restoreSession();
    expect(texts()).toEqual(["one", "two", "three"]);
    expect(useWorkspaces.getState().activeId).toBe(LAST_ID);
    expect(getUiState(SESSION_KEY)).toBe(old);
  });

  it("relaunching restores the workspace that was active", () => {
    open("stg1", "in the checklist");
    saveAs("Release checklist");
    persistSession();
    const active = useWorkspaces.getState().activeId;
    // restart: the stores forget, the saved state stays
    stop();
    useWorkspace.setState({ tabs: [], activeTabId: null });
    useWorkspaces.setState({ activeId: LAST_ID, items: [] });
    stop = startWorkspaces();
    restoreSession();
    expect(useWorkspaces.getState().activeId).toBe(active);
    expect(texts()).toEqual(["in the checklist"]);
  });

  it("keeps the last session untouched while a named workspace is open", () => {
    open("stg1", "before");
    persistSession();
    const before = getUiState(SESSION_KEY);
    saveAs("Named");
    useWorkspace
      .getState()
      .updateTabState<Doc>(useWorkspace.getState().tabs[0].id, { text: "after" });
    persistSession();
    expect(getUiState(SESSION_KEY)).toBe(before);
  });
});
