import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { setPlatformForTests } from "../lib/platform";
import { clearShortcuts, dispatchShortcut } from "../shell/registry/shortcuts";
import { clearCommands, registerCommand } from "../shell/registry/commands";
import { ConnectionDialogHost } from "./ConnectionDialog";
import { useConnections } from "./connectionsStore";
import { newDraft } from "./draft";
import type { SaveRequest } from "./api";

const api = vi.hoisted(() => ({
  save: vi.fn(),
  test: vi.fn(),
  cancel: vi.fn(async (_id: string) => {}),
  groupsSave: vi.fn(),
}));

const oracle = vi.hoisted(() => ({
  status: null as null | {
    found: boolean;
    dir: string | null;
    version: string | null;
    searched: string[];
  },
  choose: vi.fn(),
}));
vi.mock("./oracleClient", async (orig) => ({
  ...(await orig<typeof import("./oracleClient")>()),
  useOracleClient: () => ({ status: oracle.status, choose: oracle.choose }),
}));

vi.mock("./api", () => ({
  connectionsList: async () => ({ version: 1, groups: [], connections: [] }),
  connectionsSave: (req: SaveRequest) => api.save(req),
  connectionsTest: (req: SaveRequest, id: string) => api.test(req, id),
  connectionsTestCancel: (id: string) => api.cancel(id),
  connectionSecretStatus: async () => ({
    password: true,
    sshPassphrase: false,
    sshPassword: false,
    keychainUnavailable: false,
  }),
  groupsSave: (g: unknown) => api.groupsSave(g),
}));

vi.mock("../lib/ipc/drivers", () => ({
  driversList: async () => [
    {
      family: "sql",
      drivers: ["postgres", "mysql", "mariadb", "sqlite"].map((id) => ({ id })),
    },
  ],
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "code" in e && "message" in e,
}));

const open = (draft = newDraft()) => {
  act(() => useConnections.getState().openNew(draft));
  return render(<ConnectionDialogHost />);
};

beforeEach(() => {
  vi.clearAllMocks();
  clearShortcuts();
  clearCommands();
  setPlatformForTests("mac");
  api.save.mockImplementation(async (req: SaveRequest) => ({
    connection: { ...req.connection, id: "c_1" },
    warnings: [],
  }));
  useConnections.setState({
    dialog: null,
    file: { version: 1, groups: [{ id: "g_1", name: "Work", order: 0 }], connections: [] },
  });
});

describe("ConnectionDialog", () => {
  it("shows the network form for PostgreSQL and the file form for SQLite (spec: connection-management › File driver form)", async () => {
    open();
    expect(screen.getByLabelText("Host")).toHaveValue("localhost");
    expect(screen.getByLabelText("Port")).toHaveValue("5432");

    fireEvent.click(screen.getByRole("button", { name: /SQLite/ }));
    expect(screen.queryByLabelText("Host")).toBeNull();
    expect(screen.queryByLabelText("Port")).toBeNull();
    expect(screen.getByLabelText("SQLite database file")).toBeInTheDocument();
    expect(screen.getByLabelText(/Create the file if it doesn/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Choose…" })).toBeInTheDocument();
  });

  it("changes the port with the driver unless it was edited, and updates the URL preview (spec: connection-management › Switch driver)", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /MySQL/ }));
    expect(screen.getByLabelText("Port")).toHaveValue("3306");
    expect(screen.getByTestId("url-preview")).toHaveTextContent("mysql://localhost:3306");

    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "3310" } });
    fireEvent.click(screen.getByRole("button", { name: /MariaDB/ }));
    expect(screen.getByLabelText("Port")).toHaveValue("3310");
  });

  it("suggests <env>-<driver> as the name until the user types one (spec: connection-management › Name suggestion)", () => {
    open();
    const name = screen.getByLabelText("Name");
    expect(name).toHaveValue("local-postgres");
    fireEvent.click(screen.getByRole("radio", { name: "Production" }));
    expect(name).toHaveValue("prod-postgres");
    fireEvent.click(screen.getByRole("button", { name: /MySQL/ }));
    expect(name).toHaveValue("prod-mysql");
    fireEvent.change(name, { target: { value: "Warehouse" } });
    fireEvent.click(screen.getByRole("radio", { name: "Staging" }));
    expect(name).toHaveValue("Warehouse");
  });

  it("shows the Production safeguards box, all checked, only for production (spec: connection-management › Production safeguards box)", () => {
    open();
    expect(screen.queryByTestId("prod-safeguards")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Production" }));
    const box = within(screen.getByTestId("prod-safeguards"));
    expect(box.getByText("Production safeguards")).toBeInTheDocument();
    for (const cb of box.getAllByRole("checkbox")) expect(cb).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Development" }));
    expect(screen.queryByTestId("prod-safeguards")).toBeNull();
  });

  it("marks an empty host and a bad port invalid and saves nothing (spec: connection-management › Validation)", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("Port"), { target: { value: "70000" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & connect/ }));
    expect(await screen.findByText("Enter a host")).toBeInTheDocument();
    expect(screen.getByText("Port must be 1–65535")).toBeInTheDocument();
    expect(screen.getByLabelText("Host")).toHaveAttribute("aria-invalid", "true");
    expect(api.save).not.toHaveBeenCalled();
  });

  it("saves, closes and opens the connection on Save & connect", async () => {
    const opened = vi.fn();
    registerCommand({ id: "connection.open", title: "Open", category: "c", run: opened });
    open();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db.internal" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "pw" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & connect/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    const req = api.save.mock.calls[0][0] as SaveRequest;
    expect(req.connection.settings).toMatchObject({
      kind: "network",
      host: "db.internal",
      port: 5432,
    });
    expect(req.password).toEqual({ action: "set", value: "pw" });
    await waitFor(() => expect(opened).toHaveBeenCalledWith("c_1"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows the Neo4j form: protocol, host, port 7687, user, password, database and the AuraDB hint (spec: graph-browser › Graph console tab)", async () => {
    open(newDraft("neo4j"));
    const protocol = screen.getByLabelText("Protocol") as HTMLSelectElement;
    expect([...protocol.options].map((o) => o.textContent)).toEqual([
      "neo4j://",
      "neo4j+s://",
      "bolt://",
      "bolt+s://",
    ]);
    expect(screen.getByLabelText("Host")).toHaveValue("localhost");
    expect(screen.getByLabelText("Port")).toHaveValue("7687");
    expect(screen.getByLabelText("User")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
    expect(screen.getByLabelText("Database")).toBeInTheDocument();
    expect(screen.getByText(/for AuraDB/)).toBeInTheDocument();

    fireEvent.change(protocol, { target: { value: "neo4j+s" } });
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "x.databases.neo4j.io" } });
    fireEvent.change(screen.getByLabelText("User"), { target: { value: "neo4j" } });
    fireEvent.change(screen.getByLabelText("Database"), { target: { value: "movies" } });
    expect(screen.getByTestId("url-preview")).toHaveTextContent(
      "neo4j+s://neo4j@x.databases.neo4j.io:7687/movies",
    );
    fireEvent.click(screen.getByRole("button", { name: /Save & connect/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect((api.save.mock.calls[0][0] as SaveRequest).connection.settings).toMatchObject({
      kind: "neo4j",
      protocol: "neo4j+s",
      host: "x.databases.neo4j.io",
      port: 7687,
      user: "neo4j",
      database: "movies",
    });
  });

  it("saves a default isolation level from Advanced settings, only where the driver has levels (spec: sql-console › Connection default)", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "db" } });
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    fireEvent.change(screen.getByLabelText("Default isolation level"), {
      target: { value: "REPEATABLE READ" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Save & connect/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(
      (api.save.mock.calls[0][0] as SaveRequest).connection.advanced as { isolation?: string },
    ).toMatchObject({ isolation: "REPEATABLE READ" });
  });

  it("does not offer a default isolation level for SQLite", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: /SQLite/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
    expect(screen.queryByLabelText("Default isolation level")).toBeNull();
  });

  it("closes on Escape and saves on Mod+Enter", async () => {
    const first = open();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    first.unmount();

    open();
    const dialog = screen.getByRole("dialog");
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      code: "Enter",
      metaKey: true,
      bubbles: true,
    });
    Object.defineProperty(event, "target", { value: within(dialog).getByLabelText("Host") });
    act(() => {
      dispatchShortcut(event);
    });
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
  });

  it("creates a new group when asked", async () => {
    api.groupsSave.mockResolvedValue({ id: "g_new", name: "Fresh", order: 1 });
    open();
    fireEvent.change(screen.getByLabelText("Group"), { target: { value: "__new__" } });
    fireEvent.change(screen.getByLabelText("New group name"), { target: { value: "Fresh" } });
    fireEvent.click(screen.getByRole("button", { name: /Save & connect/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalled());
    expect(api.groupsSave).toHaveBeenCalledWith({ id: "", name: "Fresh", order: 1 });
    expect((api.save.mock.calls[0][0] as SaveRequest).connection.groupId).toBe("g_new");
  });

  it("marks drivers that are not installed", async () => {
    open();
    expect(await screen.findByRole("button", { name: /Oracle/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /PostgreSQL/ })).toBeEnabled();
  });

  it("filters the driver list by search", () => {
    open();
    fireEvent.change(screen.getByLabelText("Search drivers"), { target: { value: "red" } });
    expect(screen.getByRole("button", { name: /Redis/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /PostgreSQL/ })).toBeNull();
  });
});

describe("Test connection", () => {
  it("shows the server and timing on success, with the SSH host when tunnelled (spec: connection-management › Success)", async () => {
    api.test.mockResolvedValue({ product: "PostgreSQL", version: "16.2", round_trip_ms: 42 });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Connected · PostgreSQL 16.2 · 42 ms",
    );

    fireEvent.click(screen.getByRole("tab", { name: "SSH tunnel" }));
    fireEvent.click(screen.getByLabelText(/Connect through an SSH tunnel/));
    fireEvent.change(screen.getByLabelText("SSH host"), { target: { value: "bastion" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("42 ms via bastion"));
  });

  it("shows the failure in danger colour with a Details toggle (spec: connection-management › Failure)", async () => {
    api.test.mockRejectedValue({
      code: "auth_failed",
      message: "Password authentication failed for user “karthik”",
      detail: "FATAL: 28P01",
    });
    open();
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText(/authentication failed/)).toBeInTheDocument();
    expect(screen.queryByText("FATAL: 28P01")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    expect(screen.getByText("FATAL: 28P01")).toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("offers Cancel test after 2 seconds and aborts the attempt (spec: connection-management › Cancel a slow test)", async () => {
    vi.useFakeTimers();
    try {
      api.test.mockImplementation(() => new Promise(() => {}));
      open();
      fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
      expect(screen.queryByRole("button", { name: "Cancel test" })).toBeNull();
      await act(async () => {
        vi.advanceTimersByTime(2100);
      });
      fireEvent.click(screen.getByRole("button", { name: "Cancel test" }));
      expect(api.cancel).toHaveBeenCalledWith(api.test.mock.calls[0][1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not test an invalid draft", async () => {
    open();
    fireEvent.change(screen.getByLabelText("Host"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Test connection" }));
    expect(await screen.findByText("Enter a host")).toBeInTheDocument();
    expect(api.test).not.toHaveBeenCalled();
  });
});

describe("Oracle Instant Client", () => {
  beforeEach(() => {
    oracle.status = null;
    oracle.choose.mockClear();
  });

  it("is checked at connect time while its status is unknown", () => {
    open(newDraft("oracle"));
    expect(screen.getByTestId("instant-client-status")).toHaveTextContent(
      "checked when you connect",
    );
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("says what to install when it is missing, and blocks Test connection (spec: driver-framework › Instant Client missing)", () => {
    oracle.status = { found: false, dir: null, version: null, searched: ["/opt/oracle"] };
    open(newDraft("oracle"));
    const note = screen.getByRole("alert");
    expect(note).toHaveTextContent("Oracle needs the free Oracle Instant Client");
    expect(note).toHaveTextContent("oracle.com/database/technologies/instant-client");
    expect(note).toHaveTextContent("macOS");
    expect(note).toHaveTextContent("Windows");
    expect(screen.getByRole("button", { name: "Test connection" })).toBeDisabled();
    fireEvent.click(within(note).getByRole("button", { name: "Choose folder…" }));
    expect(oracle.choose).toHaveBeenCalledTimes(1);
  });

  it("shows the version and folder when it is found", () => {
    oracle.status = {
      found: true,
      dir: "/opt/oracle/instantclient_19_8",
      version: "19.8",
      searched: [],
    };
    open(newDraft("oracle"));
    expect(screen.getByTestId("instant-client-status")).toHaveTextContent(
      "Oracle Instant Client 19.8 found in /opt/oracle/instantclient_19_8",
    );
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });

  it("does not bother other drivers", () => {
    oracle.status = { found: false, dir: null, version: null, searched: [] };
    open(newDraft("postgres"));
    expect(screen.queryByTestId("instant-client-status")).toBeNull();
    expect(screen.getByRole("button", { name: "Test connection" })).toBeEnabled();
  });
});
