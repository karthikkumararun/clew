import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useConnections } from "../../connections/connectionsStore";
import type { NodePath } from "../../lib/ipc/drivers";
import { setPlatformForTests } from "../../lib/platform";
import { resetUiState } from "../../lib/uiState";
import { clearCommands, registerCommand } from "../../shell/registry/commands";
import { clearShortcuts } from "../../shell/registry/shortcuts";
import { registerExplorerCommands } from "./commands";
import { ExplorerPanel } from "./ExplorerPanel";
import { startExplorerSync, useExplorer } from "./explorerStore";
import { conn, file, stubLayout, tn } from "./testing";
import { scriptNodeId, scriptsNodeId } from "./tree";

const api = vi.hoisted(() => ({
  children: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  reveal: vi.fn(),
}));
vi.mock("../../lib/ipc/drivers", () => ({
  introspectChildren: (...a: unknown[]) => api.children(...a),
  introspectDdl: vi.fn(),
  isAppError: () => false,
}));
vi.mock("./api", () => ({
  explorerCountRows: vi.fn(),
  scriptsList: (...a: unknown[]) => api.list(...a),
  scriptsNew: (...a: unknown[]) => api.create(...a),
  scriptsReveal: (...a: unknown[]) => api.reveal(...a),
}));

const file1 = {
  name: "monthly_revenue.sql",
  relPath: "monthly_revenue.sql",
  path: "/s/analytics-prod/monthly_revenue.sql",
};
const file2 = { name: "q.sql", relPath: "reports/q.sql", path: "/s/analytics-prod/reports/q.sql" };

const calls: Record<string, unknown[]> = {};
const record = (id: string) =>
  registerCommand({
    id,
    title: id,
    category: "Test",
    run: (arg) => void (calls[id] ??= []).push(arg),
  });

let restore: () => void = () => {};
let stop: () => void = () => {};

async function openScripts() {
  const ex = useExplorer.getState();
  await act(async () => {
    await ex.toggle("c1");
    await ex.toggle(scriptsNodeId("c1"));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetUiState();
  clearShortcuts();
  clearCommands();
  setPlatformForTests("mac");
  for (const k of Object.keys(calls)) delete calls[k];
  restore = stubLayout();
  registerExplorerCommands();
  api.children.mockImplementation(async (_c: string, p: NodePath) =>
    p.length === 0 ? [tn([], "database", "analytics")] : [],
  );
  api.list.mockResolvedValue([file1, file2]);
  useExplorer.setState({
    nodes: {},
    expanded: new Set(),
    collapsedGroups: new Set(),
    selectedId: null,
    filter: "",
    counts: {},
  });
  useConnections.setState({
    file: file([conn("c1", "analytics-prod"), conn("c2", "dev-mongo", { driver: "mongodb" })]),
    connected: {},
    busy: {},
    connect: vi.fn(async (id: string) => {
      useConnections.setState((s) => ({ connected: { ...s.connected, [id]: {} as never } }));
      return true;
    }),
  });
  stop = startExplorerSync();
});
afterEach(() => {
  stop();
  restore();
});

describe("Scripts node", () => {
  it("lists the linked SQL files under each SQL connection, with a count", async () => {
    render(<ExplorerPanel />);
    await openScripts();
    expect(api.list).toHaveBeenCalledWith("c1");
    const scripts = await screen.findByRole("treeitem", { name: /^Scripts/ });
    expect(scripts).toHaveTextContent("2");
    expect(screen.getByRole("treeitem", { name: "monthly_revenue.sql" })).toBeInTheDocument();
    expect(screen.getByRole("treeitem", { name: "reports/q.sql" })).toBeInTheDocument();
  });

  it("does not add a Scripts node to non-SQL connections", async () => {
    render(<ExplorerPanel />);
    await act(async () => {
      await useExplorer.getState().toggle("c2");
    });
    expect(screen.queryByRole("treeitem", { name: /^Scripts/ })).toBeNull();
  });

  it("opens a script in a console bound to its connection", async () => {
    record("script.open");
    render(<ExplorerPanel />);
    await openScripts();
    fireEvent.doubleClick(await screen.findByRole("treeitem", { name: "monthly_revenue.sql" }));
    expect(calls["script.open"]).toEqual([
      { connectionId: "c1", path: "/s/analytics-prod/monthly_revenue.sql" },
    ]);
    // Enter does the same.
    act(() => useExplorer.getState().select(scriptNodeId("c1", "reports/q.sql")));
    fireEvent.keyDown(screen.getByRole("tree"), { key: "Enter" });
    expect(calls["script.open"]?.[1]).toEqual({
      connectionId: "c1",
      path: "/s/analytics-prod/reports/q.sql",
    });
  });

  it("drops a file deleted on disk after Refresh", async () => {
    render(<ExplorerPanel />);
    await openScripts();
    await screen.findByRole("treeitem", { name: "reports/q.sql" });
    api.list.mockResolvedValue([file1]);
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /^Scripts/ }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" })));
    await waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: "reports/q.sql" })).toBeNull(),
    );
    expect(screen.getByRole("treeitem", { name: "monthly_revenue.sql" })).toBeInTheDocument();
  });

  it("New script creates the file, refreshes the list and opens it", async () => {
    record("script.open");
    api.create.mockResolvedValue("/s/analytics-prod/script.sql");
    render(<ExplorerPanel />);
    await openScripts();
    api.list.mockResolvedValue([
      file1,
      file2,
      { name: "script.sql", relPath: "script.sql", path: "/s/analytics-prod/script.sql" },
    ]);
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /^Scripts/ }));
    await act(async () => fireEvent.click(screen.getByRole("menuitem", { name: "New script" })));
    expect(api.create).toHaveBeenCalledWith("c1", "script");
    expect(await screen.findByRole("treeitem", { name: "script.sql" })).toBeInTheDocument();
    expect(calls["script.open"]).toEqual([
      { connectionId: "c1", path: "/s/analytics-prod/script.sql" },
    ]);
  });

  it("Reveal targets the folder from the Scripts node and the file from a script", async () => {
    render(<ExplorerPanel />);
    await openScripts();
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /^Scripts/ }));
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" })),
    );
    expect(api.reveal).toHaveBeenLastCalledWith("c1", undefined);
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "reports/q.sql" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("menuitem", { name: "Reveal in Finder" })),
    );
    expect(api.reveal).toHaveBeenLastCalledWith("c1", "reports/q.sql");
  });

  it("offers Explorer on Windows", async () => {
    setPlatformForTests("windows");
    render(<ExplorerPanel />);
    await openScripts();
    fireEvent.contextMenu(await screen.findByRole("treeitem", { name: /^Scripts/ }));
    expect(screen.getByRole("menuitem", { name: "Reveal in Explorer" })).toBeInTheDocument();
  });
});
