import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Value } from "../../lib/ipc/drivers";
import { CellViewer, hexDump } from "./CellViewer";

const col = { name: "payload", type_name: "jsonb", kind: "json" as const, nullable: true };

describe("hexDump", () => {
  it("lays bytes out 16 to a line with offsets and ASCII", () => {
    const hex = "48656c6c6f2c20776f726c6421000102" + "ff";
    const lines = hexDump(hex);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toEqual({
      offset: "00000000",
      bytes: "48 65 6c 6c 6f 2c 20 77 6f 72 6c 64 21 00 01 02",
      ascii: "Hello, world!...",
    });
    expect(lines[1]).toEqual({ offset: "00000010", bytes: "ff", ascii: "." });
  });
});

describe("CellViewer", () => {
  const json: Value = {
    kind: "json",
    value: { id: 7, tags: ["a", "b"], nested: { ok: true, none: null } },
  };

  it("shows indented, highlighted JSON that folds", () => {
    render(<CellViewer value={json} column={col} onClose={() => {}} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("payload · jsonb");
    const tree = screen.getByRole("tree", { name: "JSON" });
    expect(tree).toHaveTextContent('"id": 7');
    expect(tree).toHaveTextContent('"tags": [');
    expect(tree).toHaveTextContent('"ok": true');
    fireEvent.click(screen.getByRole("button", { name: "Fold nested" }));
    expect(tree).not.toHaveTextContent('"ok": true');
    expect(tree).toHaveTextContent("2 items");
    fireEvent.click(screen.getByRole("button", { name: "Unfold nested" }));
    expect(tree).toHaveTextContent('"ok": true');
  });

  it("copies the pretty-printed JSON", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<CellViewer value={json} column={col} onClose={() => {}} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Copy" })));
    expect(writeText).toHaveBeenCalledWith(
      JSON.stringify((json as { value: unknown }).value, null, 2),
    );
  });

  it("shows bytes as a hex dump with their length", () => {
    render(
      <CellViewer value={{ kind: "bytes", value: "48656c6c6f", len: 5 }} onClose={() => {}} />,
    );
    expect(screen.getByText("5 bytes")).toBeInTheDocument();
    expect(screen.getByLabelText("Hex dump")).toHaveTextContent("48 65 6c 6c 6f");
    expect(screen.getByLabelText("Hex dump")).toHaveTextContent("Hello");
  });

  it("wraps long text and counts its characters", () => {
    render(<CellViewer value={{ kind: "text", value: "héllo 😀 wörld" }} onClose={() => {}} />);
    expect(screen.getByText("13 characters")).toBeInTheDocument();
    expect(screen.getByText("héllo 😀 wörld")).toBeInTheDocument();
  });

  it("shows NULL", () => {
    render(<CellViewer value={{ kind: "null" }} onClose={() => {}} />);
    expect(screen.getByText("NULL")).toBeInTheDocument();
  });

  it("fetches the whole value of a truncated cell", async () => {
    const full: Value = { kind: "text", value: "the whole long value" };
    render(
      <CellViewer
        value={{ kind: "text", value: "the whole", truncated: true }}
        fetchFull={Promise.resolve(full)}
        onClose={() => {}}
      />,
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("the whole long value")).toBeInTheDocument());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says so when the full value can't be fetched", async () => {
    render(
      <CellViewer
        value={{ kind: "text", value: "start", truncated: true }}
        fetchFull={Promise.reject({ message: "row not found" })}
        onClose={() => {}}
      />,
    );
    expect(await screen.findByText("row not found")).toBeInTheDocument();
    expect(screen.getByText("start")).toBeInTheDocument();
  });

  it("closes", () => {
    const onClose = vi.fn();
    render(<CellViewer value={{ kind: "null" }} onClose={onClose} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).slice(-1)[0]);
    expect(onClose).toHaveBeenCalled();
  });
});
