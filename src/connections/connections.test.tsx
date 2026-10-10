import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setPlatformForTests } from "../lib/platform";
import { useNotices } from "../stores/noticesStore";
import { useWorkspace } from "../stores/workspaceStore";
import { clearCommands, registerCommand } from "../shell/registry/commands";
import { clearShortcuts } from "../shell/registry/shortcuts";
import { useRecents } from "../shell/registry/recents";
import { useSlots } from "../shell/registry/slots";
import { ConnectionChip, namespaceMenu } from "./ConnectionChip";
import { ExplorerPanel } from "../features/explorer/ExplorerPanel";
import { registerExplorerCommands } from "../features/explorer/commands";
import { stubLayout } from "../features/explorer/testing";
import { ConnectionModals } from "./ConnectionPrompts";
import { openFromUrl, recentsOf, registerConnectionCommands } from "./commands";
import { useConnections } from "./connectionsStore";
import { relativeTime, shortAddress } from "./display";
import { newDraft, toConnection } from "./draft";
import type { Connection, ConnectionsFile } from "./api";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  openTx: vi.fn(),
  del: vi.fn(),
  save: vi.fn(),
  rename: vi.fn(),
  finishRename: vi.fn(),
  duplicate: vi.fn(),
  groupsSave: vi.fn(),
  groupsDelete: vi.fn(),
  switchNs: vi.fn(),
  parseUrl: vi.fn(),
  introspect: vi.fn(),
}));

vi.mock("../lib/ipc", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/ipc")>()),
  isTauri: () => true,
}));
vi.mock("./api", () => ({
  connectionsList: () => api.list(),
  connectionsConnect: (id: string) => api.connect(id),
  connectionsDisconnect: (id: string, end?: string) => api.disconnect(id, end),
  connectionsOpenTransactions: (id: string) => api.openTx(id),
  connectionsDelete: (id: string) => api.del(id),
  connectionsSave: (r: unknown) => api.save(r),
  connectionsDuplicate: (id: string) => api.duplicate(id),
  connectionsRename: (id: string, n: string) => api.rename(id, n),
  connectionsFinishFolderRename: (id: string, o: unknown, r: boolean) => api.finishRename(id, o, r),
  groupsSave: (g: unknown) => api.groupsSave(g),
  groupsDelete: (id: string) => api.groupsDelete(id),
  sessionSwitchNamespace: (s: string, t: unknown) => api.switchNs(s, t),
  connectionsParseUrl: (u: string) => api.parseUrl(u),
  connectionSecretStatus: async () => ({}),
}));
vi.mock("../lib/ipc/drivers", () => ({
  driversList: async () => [],
  isAppError: () => false,
  introspectChildren: (id: string, path: unknown) => api.introspect(id, path),
  hostKeyAnswer: async () => true,
}));

function make(id: string, name: string, extra: Partial<Connection> = {}): Connection {
  return {
    ...toConnection({
      ...newDraft("postgres"),
      id,
      name,
      host: "db.internal",
      database: "analytics",
    }),
    ...extra,
  };
}

const prod = make("c1", "prod-postgres", {
  environment: "production",
  lastUsedAt: "2026-10-10T09:00:00Z",
});
const dev = make("c2", "dev-mongo", { lastUsedAt: "2026-10-10T11:30:00Z" });

function setFile(file: Partial<ConnectionsFile>) {
  const full = { version: 1, groups: [], connections: [], ...file } as ConnectionsFile;
  api.list.mockResolvedValue(full);
  useConnections.setState({ file: full, connected: {}, busy: {}, modal: null, dialog: null });
}

let restoreLayout: () => void = () => {};
beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  registerExplorerCommands();
  restoreLayout = stubLayout();
  setPlatformForTests("mac");
  useNotices.setState({ notices: [] });
  useWorkspace.setState({ tabs: [], activeTabId: null, closeRequest: null });
  useSlots.setState({
    slots: { toolbarLeft: [], toolbarCenter: [], toolbarRight: [], sidebar: [] },
  });
  api.openTx.mockResolvedValue([]);
  api.connect.mockResolvedValue({
    server: { product: "PostgreSQL", version: "16.2", round_trip_ms: 4 },
    transport: null,
  });
  api.disconnect.mockResolvedValue(undefined);
  api.del.mockResolvedValue([]);
  api.save.mockImplementation(async (r: { connection: Connection }) => ({
    connection: r.connection,
    warnings: [],
  }));
  setFile({ connections: [prod, dev] });
});

afterEach(() => restoreLayout());

describe("display helpers", () => {
  it("shortens addresses per settings kind", () => {
    expect(shortAddress(prod)).toBe("db.internal:5432/analytics");
    const redis = toConnection({ ...newDraft("redis"), host: "localhost", dbIndex: "0" });
    expect(shortAddress(redis)).toBe("localhost:6379 · db 0");
    const file = toConnection({ ...newDraft("sqlite"), filePath: "/tmp/notes.sqlite" });
    expect(shortAddress(file)).toBe("/tmp/notes.sqlite");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-10-10T12:00:00Z");
    expect(relativeTime("2026-10-10T11:59:40Z", now)).toBe("just now");
    expect(relativeTime("2026-10-10T11:58:00Z", now)).toBe("2 min ago");
    expect(relativeTime("2026-10-10T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-09T11:00:00Z", now)).toBe("yesterday");
    expect(relativeTime("2026-10-05T12:00:00Z", now)).toBe("5 d ago");
    expect(relativeTime(undefined, now)).toBe("never");
  });
});

describe("recent connections", () => {
  it("lists at most five, most recently used first, never unused ones", () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      make(`c${i}`, `conn-${i}`, { lastUsedAt: `2026-10-0${i + 1}T10:00:00Z` }),
    );
    const unused = make("u", "never-used");
    const recents = recentsOf([...many, unused], Date.parse("2026-10-10T12:00:00Z"));
    expect(recents.map((r) => r.name)).toEqual(["conn-6", "conn-5", "conn-4", "conn-3", "conn-2"]);
    expect(recents[0]).toMatchObject({ driver: "postgres", env: "local", lastUsed: "3 d ago" });
  });

  it("publishes to the Welcome list and connects on open", async () => {
    const consoles = vi.fn();
    registerCommand({ id: "console.new", title: "c", category: "c", run: consoles });
    const off = registerConnectionCommands();
    expect(useRecents.getState().recents.map((r) => r.name)).toEqual([
      "dev-mongo",
      "prod-postgres",
    ]);

    const { runCommand } = await import("../shell/registry/commands");
    await runCommand("connection.open", "c1");
    expect(api.connect).toHaveBeenCalledWith("c1");
    expect(consoles).toHaveBeenCalledWith({ connectionId: "c1" });
    expect(useConnections.getState().connected.c1.server.version).toBe("16.2");
    off();
  });

  it("does not open a console when connecting fails, and says why", async () => {
    api.connect.mockRejectedValue({
      code: "auth_failed",
      message: "Password authentication failed",
    });
    const consoles = vi.fn();
    registerCommand({ id: "console.new", title: "c", category: "c", run: consoles });
    const off = registerConnectionCommands();
    const { runCommand } = await import("../shell/registry/commands");
    await runCommand("connection.open", "c1");
    expect(consoles).not.toHaveBeenCalled();
    expect(useNotices.getState().notices[0].message).toContain("Couldn't connect to prod-postgres");
    off();
  });
});

describe("pasted URL", () => {
  it("opens the dialog prefilled, with the password in the field", async () => {
    api.parseUrl.mockResolvedValue({
      driver: "postgres",
      settings: {
        kind: "network",
        host: "db.internal",
        port: 5432,
        database: "analytics",
        user: "karthik",
        passwordMode: "keychain",
      },
      tls: { mode: "require" },
      password: "secret",
      suggestedName: "analytics@db.internal",
    });
    expect(await openFromUrl("postgres://karthik:secret@db.internal/analytics")).toBe(true);
    const d = useConnections.getState().dialog!.initial;
    expect(d).toMatchObject({
      driver: "postgres",
      host: "db.internal",
      port: "5432",
      user: "karthik",
      database: "analytics",
      tlsMode: "require",
      password: "secret",
      environment: "local",
    });
  });

  it("keeps the dialog closed and shows the error for an unknown scheme", async () => {
    api.parseUrl.mockRejectedValue({
      code: "unknown_url_scheme",
      message: "Clew doesn't recognise this URL scheme",
    });
    expect(await openFromUrl("ftp://x")).toBe(false);
    expect(useConnections.getState().dialog).toBeNull();
    expect(useConnections.getState().urlError).toBe("Clew doesn't recognise this URL scheme");
  });
});

describe("organising connections", () => {
  it("deletes after confirmation, removes it from the list and closes its tabs", async () => {
    useWorkspace.setState({
      tabs: [
        { id: "t1", kind: "console", key: "k1", state: { connectionId: "c1" } },
        { id: "t2", kind: "console", key: "k2", state: { connectionId: "c2" } },
      ],
      activeTabId: "t1",
    });
    api.list.mockResolvedValue({ version: 1, groups: [], connections: [dev] });
    render(
      <>
        <ExplorerPanel />
        <ConnectionModals />
      </>,
    );
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: /prod-postgres/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete…" }));
    expect(api.del).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(api.del).toHaveBeenCalledWith("c1"));
    await waitFor(() =>
      expect(screen.queryByRole("treeitem", { name: /prod-postgres/ })).not.toBeInTheDocument(),
    );
    expect(useWorkspace.getState().tabs.map((t) => t.id)).toEqual(["t2"]);
  });

  it("duplicates into the edit dialog", async () => {
    const copy = make("c3", "prod-postgres (copy)");
    api.duplicate.mockResolvedValue({ connection: copy, warnings: [] });
    api.list.mockResolvedValue({ version: 1, groups: [], connections: [prod, dev, copy] });
    await act(async () => useConnections.getState().duplicate("c1"));
    const dialog = useConnections.getState().dialog!;
    expect(dialog.title).toBe("Edit connection");
    expect(dialog.initial.name).toBe("prod-postgres (copy)");
  });

  it("moves a connection to a group without touching secrets", async () => {
    setFile({ groups: [{ id: "g1", name: "Work", order: 0 }], connections: [prod, dev] });
    await act(async () => useConnections.getState().move("c1", "g1"));
    expect(api.save.mock.calls[0][0]).toMatchObject({
      connection: { id: "c1", groupId: "g1" },
      password: { action: "keep" },
    });
  });

  it("renames through the backend and offers to rename the Scripts folder", async () => {
    const offer = { from: "/s/prod-postgres", to: "/s/renamed" };
    api.rename.mockResolvedValueOnce(null).mockResolvedValueOnce(offer);
    await act(async () => useConnections.getState().rename("c1", "  renamed "));
    expect(api.rename).toHaveBeenCalledWith("c1", "renamed");
    expect(useConnections.getState().modal).toBeNull();

    await act(async () => useConnections.getState().rename("c1", "again"));
    expect(useConnections.getState().modal).toEqual({ kind: "folderRename", id: "c1", offer });
    await act(async () => useConnections.getState().finishFolderRename("c1", offer, true));
    expect(api.finishRename).toHaveBeenCalledWith("c1", offer, true);
    expect(useConnections.getState().modal).toBeNull();
  });

  it("resets safeguards with the environment only when they were still the defaults", async () => {
    await act(async () => useConnections.getState().setEnvironment("c1", "local"));
    expect(api.save.mock.calls[0][0].connection).toMatchObject({
      environment: "local",
      safeguards: { readOnlyByDefault: false, confirmWrites: false, manualCommit: false },
    });
    const custom = make("c9", "custom", {
      environment: "production",
      safeguards: { readOnlyByDefault: true, confirmWrites: false, manualCommit: false },
    });
    setFile({ connections: [custom] });
    await act(async () => useConnections.getState().setEnvironment("c9", "staging"));
    expect(api.save.mock.calls[1][0].connection.safeguards).toEqual(custom.safeguards);
  });

  it("groups connections and deleting a group asks first", () => {
    setFile({
      groups: [{ id: "g1", name: "Work", order: 0 }],
      connections: [{ ...prod, groupId: "g1" }, dev],
    });
    render(
      <>
        <ExplorerPanel />
        <ConnectionModals />
      </>,
    );
    const labels = screen.getAllByRole("treeitem").map((r) => r.textContent);
    expect(labels).toEqual([
      expect.stringContaining("Work"),
      expect.stringContaining("prod-postgres"),
      expect.stringContaining("Ungrouped"),
      expect.stringContaining("dev-mongo"),
    ]);
    fireEvent.contextMenu(screen.getByRole("treeitem", { name: "Work" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete group" }));
    expect(screen.getByText(/connections move to Ungrouped/)).toBeInTheDocument();
  });
});

describe("connect and disconnect", () => {
  it("asks Commit / Roll back / Cancel when a console has an open transaction", async () => {
    useConnections.setState({
      connected: {
        c1: { server: { product: "PostgreSQL", version: "16", round_trip_ms: 1 }, transport: null },
      },
    });
    api.openTx.mockResolvedValue(["session-1"]);
    render(<ConnectionModals />);
    await act(async () => useConnections.getState().requestDisconnect("c1"));
    expect(api.disconnect).not.toHaveBeenCalled();
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("button", { name: "Commit" })).toBeInTheDocument();
    expect(dialog.getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    fireEvent.click(dialog.getByRole("button", { name: "Roll back" }));
    await waitFor(() => expect(api.disconnect).toHaveBeenCalledWith("c1", "rollback"));
    expect(useConnections.getState().connected.c1).toBeUndefined();
  });

  it("disconnects straight away when nothing is pending", async () => {
    await act(async () => useConnections.getState().requestDisconnect("c1"));
    expect(api.disconnect).toHaveBeenCalledWith("c1", undefined);
  });
});

describe("toolbar chip", () => {
  const tab = {
    id: "t1",
    kind: "console",
    key: "k",
    state: { connectionId: "c1", sessionId: "session-1", database: "analytics", schema: "public" },
  };

  it("shows the connection, database and schema of the active tab", () => {
    useWorkspace.setState({ tabs: [tab], activeTabId: "t1" });
    render(<ConnectionChip />);
    expect(
      screen.getByRole("button", { name: /prod-postgres, analytics · public/ }),
    ).toBeInTheDocument();
  });

  it("renders nothing for a tab without a connection", () => {
    useWorkspace.setState({ tabs: [{ ...tab, state: {} }], activeTabId: "t1" });
    const { container } = render(<ConnectionChip />);
    expect(container).toBeEmptyDOMElement();
  });

  it("switching schema asks the session to change it and the chip follows", async () => {
    useWorkspace.setState({ tabs: [tab], activeTabId: "t1" });
    api.introspect.mockImplementation(async (_id: string, path: unknown[]) =>
      path.length === 0
        ? [{ kind: "database", name: "analytics" }]
        : [
            { kind: "schema", name: "public" },
            { kind: "schema", name: "billing" },
          ],
    );
    api.switchNs.mockResolvedValue('SET search_path TO "billing"');
    render(<ConnectionChip />);
    fireEvent.click(screen.getByRole("button", { name: /prod-postgres/ }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Schema billing" }));
    await waitFor(() =>
      expect(api.switchNs).toHaveBeenCalledWith("session-1", { schema: "billing" }),
    );
    await waitFor(() =>
      expect((useWorkspace.getState().tabs[0].state as { schema: string }).schema).toBe("billing"),
    );
  });

  it("marks the current entries in the menu", () => {
    const items = namespaceMenu(["a", "b"], ["public", "x"], { database: "a", schema: "x" });
    expect(items.map((i) => i.label)).toEqual([
      "✓ Database a",
      "Database b",
      "Schema public",
      "✓ Schema x",
    ]);
  });
});
