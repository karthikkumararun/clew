import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { setPlatformForTests } from "../../lib/platform";
import { useConnections } from "../connectionsStore";
import { newDraft, toConnection } from "../draft";
import type { Connection, ExportSummary } from "../api";
import { ImportExportDialog } from "./ImportExportDialog";
import { passphraseProblem, passphraseStrength } from "./passphrase";

const api = vi.hoisted(() => ({
  summary: vi.fn(),
  exportFile: vi.fn(),
  savePath: vi.fn(),
}));

vi.mock("../api", () => ({
  connectionsExportSummary: (ids: string[], o: unknown) => api.summary(ids, o),
  connectionsExport: (...a: unknown[]) => api.exportFile(...a),
}));
vi.mock("../files", () => ({
  pickSavePath: (o: unknown) => api.savePath(o),
  pickFile: async () => null,
}));

describe("passphrase rules", () => {
  it("needs 12 characters and a matching confirmation (spec: connection-management › Weak or mismatched passphrase)", () => {
    expect(passphraseProblem("short", "short")).toMatch(/at least 12/);
    expect(passphraseProblem("long enough passphrase", "different one entirely")).toMatch(
      /don't match/,
    );
    expect(passphraseProblem("long enough passphrase", "long enough passphrase")).toBeNull();
  });

  it("scores by length and variety", () => {
    expect(passphraseStrength("short").score).toBe(0);
    expect(passphraseStrength("aaaaaaaaaaaa").label).toBe("Weak");
    expect(passphraseStrength("correct horse battery").score).toBeGreaterThanOrEqual(3);
    expect(passphraseStrength("Tr0ub4dor&3-horse-battery-staple").label).toBe("Strong");
  });
});

function make(id: string, name: string, extra: Partial<Connection> = {}): Connection {
  return {
    ...toConnection({ ...newDraft("postgres"), id, name, host: "h" }),
    ...extra,
  };
}

const summary = (over: Partial<ExportSummary> = {}): ExportSummary => ({
  counts: { connections: 2, passwords: 2, sshKeys: 1, sqlFiles: 9 },
  warnings: [],
  encrypted: true,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  setPlatformForTests("mac");
  api.summary.mockResolvedValue(summary());
  api.savePath.mockResolvedValue("/tmp/out.clew");
  api.exportFile.mockResolvedValue(summary());
  useConnections.setState({
    selectedId: null,
    exchange: { tab: "export" },
    file: {
      version: 1,
      groups: [{ id: "g1", name: "Production", order: 0 }],
      connections: [make("c1", "prod-postgres", { groupId: "g1" }), make("c2", "staging-mysql")],
    },
  });
});

describe("Export tab", () => {
  it("lists connections by group and keeps Export disabled until the passphrase is valid (spec: connection-management › Weak or mismatched passphrase)", async () => {
    render(<ImportExportDialog />);
    expect(screen.getByText("Production")).toBeInTheDocument();
    expect(screen.getByText("Ungrouped")).toBeInTheDocument();
    const exportBtn = screen.getByRole("button", { name: "Export…" });
    expect(exportBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Passphrase"), { target: { value: "short" } });
    expect(screen.getByRole("alert")).toHaveTextContent("at least 12 characters");

    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), { target: { value: "nope" } });
    expect(screen.getByRole("alert")).toHaveTextContent("don't match");
    expect(exportBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "correct horse battery" },
    });
    expect(exportBtn).toBeEnabled();
    expect(screen.getByTestId("strength")).toHaveTextContent(/Good|Strong/);
    await waitFor(() => expect(api.summary).toHaveBeenCalled());
  });

  it("exports the checked connections to the chosen file with the passphrase", async () => {
    render(<ImportExportDialog />);
    fireEvent.click(screen.getByRole("checkbox", { name: /staging-mysql/ })); // uncheck
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(api.exportFile).toHaveBeenCalled());
    const [ids, options, pass, path] = api.exportFile.mock.calls[0];
    expect(ids).toEqual(["c1"]);
    expect(options).toEqual({
      includePasswords: true,
      includeSshKeys: true,
      includeSqlFiles: true,
    });
    expect(pass).toBe("correct horse battery");
    expect(path).toBe("/tmp/out.clew");
    expect(await screen.findByText(/Exported 2 connections/)).toBeInTheDocument();
    expect(screen.getByText(/Send the passphrase separately/)).toBeInTheDocument();
  });

  it("offers a plain .json export without a passphrase when no secrets are included (spec: connection-management › Export without secrets)", async () => {
    api.summary.mockResolvedValue(
      summary({
        encrypted: false,
        counts: { connections: 2, passwords: 0, sshKeys: 0, sqlFiles: 0 },
      }),
    );
    render(<ImportExportDialog />);
    fireEvent.click(screen.getByRole("checkbox", { name: /Saved passwords/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /SSH private keys/ }));
    await waitFor(() => expect(screen.queryByLabelText("Passphrase")).toBeNull());
    expect(screen.getByText(/plain JSON/, { selector: "p" })).toBeInTheDocument();
    expect(screen.getByText(/\.json$/)).toBeInTheDocument();
    api.savePath.mockResolvedValue("/tmp/out.json");
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    await waitFor(() => expect(api.exportFile).toHaveBeenCalled());
    expect(api.exportFile.mock.calls[0][2]).toBeNull();
  });

  it("does nothing when the save dialog is cancelled and shows backend warnings", async () => {
    api.savePath.mockResolvedValue(null);
    api.summary.mockResolvedValue(summary({ warnings: ["prod-postgres: SSH key not found"] }));
    render(<ImportExportDialog />);
    expect(await screen.findByText("prod-postgres: SSH key not found")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "correct horse battery" },
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    });
    expect(api.exportFile).not.toHaveBeenCalled();
  });

  it("shows the backend's error and stays open", async () => {
    api.exportFile.mockRejectedValue({ code: "io", message: "Couldn't write the export file" });
    render(<ImportExportDialog />);
    fireEvent.change(screen.getByLabelText("Passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.change(screen.getByLabelText("Confirm passphrase"), {
      target: { value: "correct horse battery" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(await screen.findByText("Couldn't write the export file")).toBeInTheDocument();
  });
});
