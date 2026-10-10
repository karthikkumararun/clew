import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Value } from "../../lib/ipc/drivers";
import { ExportDialog } from "./ExportDialog";
import type { ExportSource } from "./ExportDialog";
import type { ExportEvent } from "./exportIpc";

const api = vi.hoisted(() => ({ query: vi.fn(), rows: vi.fn(), cancel: vi.fn() }));
vi.mock("./exportIpc", () => ({
  exportQuery: (...a: unknown[]) => api.query(...a),
  exportRows: (...a: unknown[]) => api.rows(...a),
  exportCancel: (...a: unknown[]) => api.cancel(...a),
}));

const columns = [
  { name: "id", type_name: "int8", kind: "int" as const, nullable: false },
  { name: "name", type_name: "text", kind: "text" as const, nullable: true },
];
const rows: Value[][] = [
  [
    { kind: "int", value: 1 },
    { kind: "text", value: "Ada" },
  ],
];

const source = (over: Partial<ExportSource> = {}): ExportSource => ({
  loaded: () => ({ columns, rows }),
  loadedCount: 500,
  hasMore: true,
  sql: "select id, name from users",
  connectionId: "c1",
  driver: "postgres",
  tableName: '"public"."users"',
  name: "users",
  ...over,
});

const summary = (over = {}) => ({
  rows: 12_000,
  bytes: 2_500_000,
  path: "/tmp/users.csv",
  cancelled: false,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  api.query.mockResolvedValue(summary());
  api.rows.mockResolvedValue(summary({ rows: 1, bytes: 40 }));
  api.cancel.mockResolvedValue(undefined);
});

describe("ExportDialog", () => {
  it("defaults to all rows when the server has more, and exports the whole query", async () => {
    render(<ExportDialog source={source()} onClose={() => {}} />);
    expect(screen.getByRole("radio", { name: /All rows/ })).toBeChecked();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(api.query).toHaveBeenCalledTimes(1);
    const [request] = api.query.mock.calls[0];
    expect(request).toMatchObject({
      connectionId: "c1",
      sql: "select id, name from users",
      format: "csv",
      defaultName: "users",
      options: {
        header: true,
        delimiter: ",",
        nullText: "",
        dateFormat: "iso",
        flavor: "postgres",
        table: '"public"."users"',
      },
    });
    expect(request.exportId).toMatch(/^export-/);
    expect(await screen.findByRole("status")).toHaveTextContent("Exported 12,000 rows · 2.4 MB");
    expect(screen.getByText("/tmp/users.csv")).toBeInTheDocument();
  });

  it("exports the loaded rows without re-running the query", async () => {
    render(<ExportDialog source={source()} onClose={() => {}} />);
    fireEvent.click(screen.getByRole("radio", { name: /Loaded rows only \(500\+\)/ }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(api.query).not.toHaveBeenCalled();
    expect(api.rows).toHaveBeenCalledWith(
      expect.objectContaining({ columns, rows, format: "csv", defaultName: "users" }),
    );
    expect(await screen.findByText(/Exported 1 row ·/)).toBeInTheDocument();
  });

  it("can only export loaded rows when there is no statement to re-run", () => {
    render(<ExportDialog source={source({ sql: undefined, hasMore: false })} onClose={() => {}} />);
    expect(screen.getByRole("radio", { name: /All rows/ })).toBeDisabled();
    expect(screen.getByRole("radio", { name: /Loaded rows only/ })).toBeChecked();
  });

  it("sends the chosen options", async () => {
    render(<ExportDialog source={source()} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("Delimiter"), { target: { value: ";" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "Header row" }));
    fireEvent.change(screen.getByLabelText("NULL as"), { target: { value: "\\N" } });
    fireEvent.change(screen.getByLabelText("Dates and times"), { target: { value: "epoch" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(api.query.mock.calls[0][0].options).toMatchObject({
      header: false,
      delimiter: ";",
      nullText: "\\N",
      dateFormat: "epoch",
    });
  });

  it("shows only the options a format uses", () => {
    render(<ExportDialog source={source()} onClose={() => {}} />);
    const format = screen.getByLabelText("Format");
    expect(screen.getByLabelText("Delimiter")).toBeInTheDocument();
    fireEvent.change(format, { target: { value: "tsv" } });
    expect(screen.queryByLabelText("Delimiter")).toBeNull();
    expect(screen.getByRole("checkbox", { name: "Header row" })).toBeInTheDocument();
    fireEvent.change(format, { target: { value: "json" } });
    expect(screen.queryByRole("checkbox", { name: "Header row" })).toBeNull();
    expect(screen.queryByLabelText("NULL as")).toBeNull();
    fireEvent.change(format, { target: { value: "markdown" } });
    expect(screen.getByLabelText("NULL as")).toBeInTheDocument();
    fireEvent.change(format, { target: { value: "insert" } });
    expect(screen.getByLabelText("Dates and times")).toBeDisabled();
  });

  it("passes the dialect and table for SQL INSERT", async () => {
    render(
      <ExportDialog
        source={source({ driver: "mysql", tableName: "`users`" })}
        onClose={() => {}}
      />,
    );
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "insert" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(api.query.mock.calls[0][0]).toMatchObject({
      format: "insert",
      options: { flavor: "mysql", table: "`users`" },
    });
  });

  it("shows progress while streaming and offers Cancel", async () => {
    let emit: (e: ExportEvent) => void = () => {};
    let finish: (v: unknown) => void = () => {};
    api.query.mockImplementation(
      (_r: unknown, on: (e: ExportEvent) => void) =>
        new Promise((resolve) => {
          emit = on;
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    render(<ExportDialog source={source()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Export…" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Waiting for the first rows");
    act(() => emit({ event: "progress", rows: 45_000, bytes: 3_200_000 }));
    expect(screen.getByRole("status")).toHaveTextContent("45,000 rows · 3.1 MB");

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Cancel export" })));
    expect(api.cancel).toHaveBeenCalledWith(api.query.mock.calls[0][0].exportId);
    await act(async () => finish(summary({ cancelled: true, rows: 45_000 })));
    expect(onClose).toHaveBeenCalled();
  });

  it("stays open when the save dialog is cancelled", async () => {
    api.query.mockResolvedValue(null);
    const onClose = vi.fn();
    render(<ExportDialog source={source()} onClose={onClose} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Export…" })).toBeEnabled();
  });

  it("shows the error and lets the user try again", async () => {
    api.query.mockRejectedValueOnce({ message: "disk full" });
    render(<ExportDialog source={source()} onClose={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Export…" })));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Exported 12,000 rows"),
    );
  });
});
