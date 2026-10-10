import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setPlatformForTests } from "../../lib/platform";
import type { CandidateView, ScanView } from "../api";
import { useConnections } from "../connectionsStore";
import { ImportExportDialog } from "./ImportExportDialog";

const api = vi.hoisted(() => ({
  discover: vi.fn(),
  inspect: vi.fn(),
  scan: vi.fn(),
  commit: vi.fn(),
  pickFile: vi.fn(),
  pickFolder: vi.fn(),
}));

vi.mock("../api", () => ({
  importDatagripDiscover: () => api.discover(),
  importClewInspect: (p: string) => api.inspect(p),
  importScan: (s: unknown) => api.scan(s),
  importCommit: (...a: unknown[]) => api.commit(...a),
  connectionsExportSummary: async () => null,
  connectionsExport: async () => null,
}));
vi.mock("../files", () => ({
  pickFile: (o: unknown) => api.pickFile(o),
  pickFolder: (o: unknown) => api.pickFolder(o),
  pickSavePath: async () => null,
}));

const cand = (over: Partial<CandidateView>): CandidateView => ({
  key: "k",
  name: "x",
  driver: "postgres",
  driverLabel: "PostgreSQL",
  address: "db.internal:5432/analytics",
  sqlFiles: 0,
  status: "new",
  note: null,
  hasPassword: false,
  group: null,
  environment: null,
  ...over,
});

const scanView = (): ScanView => ({
  scanId: "s1",
  scratchFiles: 0,
  warnings: [],
  candidates: [
    cand({ key: "a", name: "analytics-prod", sqlFiles: 4 }),
    cand({ key: "b", name: "billing-mysql", driver: "mysql", sqlFiles: 2 }),
    cand({ key: "c", name: "prod-postgres", status: "existing", sqlFiles: 1 }),
    cand({ key: "d", name: "old-cassandra", status: "unavailable", note: "Driver not available" }),
  ],
});

beforeEach(() => {
  vi.clearAllMocks();
  setPlatformForTests("mac");
  api.discover.mockResolvedValue([
    { label: "DataGrip 2026.1", path: "/jb/DataGrip2026.1" },
    { label: "DataGrip 2025.3", path: "/jb/DataGrip2025.3" },
  ]);
  api.scan.mockResolvedValue(scanView());
  api.commit.mockResolvedValue({ added: 2, merged: 0, sqlFiles: 6, warnings: [] });
  useConnections.setState({
    selectedId: null,
    exchange: { tab: "import" },
    load: vi.fn().mockResolvedValue(undefined),
  });
});

describe("Import tab", () => {
  it("scans the newest DataGrip folder and checks only new rows", async () => {
    render(<ImportExportDialog />);
    await screen.findByRole("checkbox", { name: "Import analytics-prod" });
    expect(api.scan).toHaveBeenCalledWith({
      kind: "dataGrip",
      dir: "/jb/DataGrip2026.1",
      projects: [],
      includePasswords: false,
      keepassPassword: null,
    });
    expect(screen.getByRole("checkbox", { name: "Import analytics-prod" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Import prod-postgres" })).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: /old-cassandra \(not available\)/ }),
    ).toBeDisabled();
    expect(screen.getByText("Already in Clew · merge SQL files only")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Import 2 connections · 6 files" })).toBeEnabled();
  });

  it("commits the checked rows; an existing row is merge-only", async () => {
    render(<ImportExportDialog />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Import prod-postgres" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Import billing-mysql" })); // uncheck
    fireEvent.click(screen.getByRole("button", { name: /^Import 1 connection/ }));
    await waitFor(() => expect(api.commit).toHaveBeenCalled());
    const [scanId, selections, options] = api.commit.mock.calls[0];
    expect(scanId).toBe("s1");
    expect(selections).toEqual([
      { key: "a", mergeOnly: false },
      { key: "c", mergeOnly: true },
    ]);
    expect(options).toEqual({
      environment: null,
      group: { mode: "single", name: "Imported from DataGrip" },
      importSqlFiles: true,
    });
    expect(await screen.findByText(/Imported 2 connections/)).toBeInTheDocument();
  });

  it("sends the chosen environment and group mode", async () => {
    render(<ImportExportDialog />);
    await screen.findByRole("checkbox", { name: "Import analytics-prod" });
    fireEvent.change(screen.getByLabelText("Environment for imported connections"), {
      target: { value: "staging" },
    });
    fireEvent.change(screen.getByLabelText("Put them in group"), { target: { value: "keep" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Import SQL consoles/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Import 2 connections/ }));
    await waitFor(() => expect(api.commit).toHaveBeenCalled());
    expect(api.commit.mock.calls[0][2]).toEqual({
      environment: "staging",
      group: { mode: "keep" },
      importSqlFiles: false,
    });
  });

  it("asks for DataGrip's KeePass master password and rescans with it", async () => {
    api.scan.mockImplementation(
      async (s: { includePasswords?: boolean; keepassPassword?: string | null }) => {
        if (s.includePasswords && !s.keepassPassword)
          throw { code: "needs_keepass_password", message: "enter its master password" };
        return scanView();
      },
    );
    render(<ImportExportDialog />);
    await screen.findByRole("checkbox", { name: "Import analytics-prod" });
    fireEvent.click(screen.getByRole("checkbox", { name: /Try to import saved passwords/ }));
    const input = await screen.findByLabelText("DataGrip's master password");
    fireEvent.change(input, { target: { value: "hunter2" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await waitFor(() =>
      expect(api.scan).toHaveBeenLastCalledWith(
        expect.objectContaining({ includePasswords: true, keepassPassword: "hunter2" }),
      ),
    );
    expect(
      await screen.findByRole("checkbox", { name: "Import analytics-prod" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("DataGrip's master password")).not.toBeInTheDocument();
  });

  it("unlocks an encrypted Clew file and shows a wrong passphrase", async () => {
    api.pickFile.mockResolvedValue("/tmp/clew-connections.clew");
    api.inspect.mockResolvedValue({
      encrypted: true,
      createdAt: "2026-10-10T09:00:00Z",
      app: "Clew 0.1.0",
      counts: { connections: 3, passwords: 3, sshKeys: 1, sqlFiles: 9 },
    });
    api.scan.mockImplementation(async (s: { passphrase: string }) => {
      if (s.passphrase !== "right passphrase")
        throw { code: "wrong_passphrase", message: "That passphrase doesn't unlock this file" };
      return scanView();
    });
    render(<ImportExportDialog />);
    fireEvent.click(await screen.findByRole("button", { name: /Clew export/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    expect(await screen.findByText("This file is encrypted")).toBeInTheDocument();
    expect(
      screen.getByText(/3 connections · encrypted passwords · 1 SSH key · 9 SQL files/),
    ).toBeInTheDocument();
    expect(api.scan).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "clew" }));

    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "nope" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("doesn't unlock");

    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "right passphrase" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    expect(
      await screen.findByRole("checkbox", { name: "Import analytics-prod" }),
    ).toBeInTheDocument();
  });

  it("rejects a file that isn't a Clew export", async () => {
    api.pickFile.mockResolvedValue("/tmp/other.json");
    api.inspect.mockRejectedValue({ code: "invalid_file", message: "That isn't a Clew export" });
    render(<ImportExportDialog />);
    fireEvent.click(await screen.findByRole("button", { name: /Clew export/ }));
    fireEvent.click(screen.getByRole("button", { name: "Choose a file…" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("isn't a Clew export");
  });

  it("scans ~/.pgpass straight away and passes the password option", async () => {
    render(<ImportExportDialog />);
    fireEvent.click(await screen.findByRole("button", { name: /pgpass/ }));
    await waitFor(() =>
      expect(api.scan).toHaveBeenLastCalledWith({
        kind: "pgpass",
        path: null,
        includePasswords: false,
      }),
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: /Import passwords/ }));
    await waitFor(() =>
      expect(api.scan).toHaveBeenLastCalledWith({
        kind: "pgpass",
        path: null,
        includePasswords: true,
      }),
    );
  });
});
