import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ColumnMeta, Value } from "../../../lib/ipc/drivers";
import { col } from "../../grid/tools/testing";
import { ValueEditorPanel } from "./ValueEditorPanel";
import type { ValueEditorCell, ValueEditorPanelProps } from "./ValueEditorPanel";

// jsdom has no layout; CodeMirror only needs these to exist.
beforeAll(() => {
  const rect = { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 };
  Range.prototype.getBoundingClientRect = () => rect as DOMRect;
  Range.prototype.getClientRects = () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: [][Symbol.iterator],
    }) as unknown as DOMRectList;
});

const uuidHex = "550e8400e29b41d4a716446655440000";
const bytes = (hex: string): Value => ({ kind: "bytes", value: hex, len: hex.length / 2 });

function mount(
  cell: Partial<ValueEditorCell> & { value: Value },
  over: Partial<ValueEditorPanelProps> = {},
) {
  const column: ColumnMeta =
    cell.column ?? col("id", cell.value.kind === "bytes" ? "bytes" : "text");
  const props: ValueEditorPanelProps = {
    cell: { key: "1:0", row: 1, column, ...cell },
    editable: true,
    onStage: vi.fn(),
    loadFile: vi.fn(async () => null),
    saveFile: vi.fn(async () => {}),
    ...over,
  };
  const r = render(<ValueEditorPanel {...props} />);
  return { props, ...r };
}

const view = () => EditorView.findFromDOM(document.querySelector(".cm-editor") as HTMLElement)!;
const docText = () => view().state.doc.toString();
const type = (text: string) =>
  act(() => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: text } }));

describe("Value editor panel", () => {
  it("shows a 16-byte value as a UUID and leaves the stored bytes unchanged (spec: data-grid › Binary as UUID)", () => {
    const { props } = mount({ value: bytes(uuidHex) });
    expect(docText()).toBe(uuidHex);
    fireEvent.change(screen.getByLabelText("Display as"), { target: { value: "uuid" } });
    expect(docText()).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(props.onStage).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stage change" })).toBeDisabled();
  });

  it("stages an edit made through Display as (spec: data-grid › Value editor panel)", () => {
    const { props } = mount({ value: bytes(uuidHex) });
    fireEvent.change(screen.getByLabelText("Display as"), { target: { value: "uuid" } });
    type("00000000-0000-0000-0000-000000000001");
    fireEvent.click(screen.getByRole("button", { name: "Stage change" }));
    expect(props.onStage).toHaveBeenCalledWith({
      kind: "value",
      value: { kind: "bytes", value: "00000000000000000000000000000001", len: 16 },
    });
  });

  it("refuses an edit that does not round trip and says why (spec: data-grid › Value editor panel)", () => {
    const { props } = mount({ value: bytes(uuidHex) });
    type("abc");
    fireEvent.click(screen.getByRole("button", { name: "Stage change" }));
    expect(screen.getByRole("alert")).toHaveTextContent("even number of digits");
    expect(props.onStage).not.toHaveBeenCalled();
  });

  it("is read-only when the result is not editable (spec: data-grid › Value editor panel)", () => {
    mount(
      { value: { kind: "text", value: "hello" } },
      { editable: false, readOnlyReason: "Read-only result" },
    );
    expect(docText()).toBe("hello");
    expect(screen.getByRole("button", { name: "Stage change" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Load file…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Load file…" })).toHaveAttribute(
      "title",
      "Read-only result",
    );
    expect(screen.getByRole("button", { name: "Save to file…" })).toBeEnabled();
  });

  it("offers Highlight as for text and hides it for binary (spec: data-grid › Value editor panel)", () => {
    const { unmount } = mount({ value: { kind: "text", value: '{"a":1}' } });
    expect(screen.getByLabelText("Highlight as")).toHaveValue("json");
    expect(
      within(screen.getByLabelText("Highlight as"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Plain", "JSON", "XML", "SQL"]);
    unmount();
    mount({ value: bytes("0001") });
    expect(screen.queryByLabelText("Highlight as")).not.toBeInTheDocument();
  });

  it("saves the full value, fetched first when truncated (spec: data-grid › Save a large value)", async () => {
    const full: Value = { kind: "text", value: "x".repeat(5000) };
    const fetchFull = vi.fn(async () => full);
    const { props } = mount(
      {
        value: { kind: "text", value: "x".repeat(100), truncated: true },
        column: col("body", "text"),
      },
      { fetchFull },
    );
    fireEvent.click(screen.getByRole("button", { name: "Save to file…" }));
    await waitFor(() => expect(props.saveFile).toHaveBeenCalledTimes(1));
    expect(fetchFull).toHaveBeenCalledTimes(1);
    const [name, written] = (props.saveFile as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(name).toBe("body.txt");
    expect((written as Uint8Array).length).toBe(5000);
  });

  it("does not edit a truncated value until it is fetched (spec: data-grid › Value editor panel)", async () => {
    const fetchFull = vi.fn(async (): Promise<Value> => ({ kind: "text", value: "full text" }));
    mount({ value: { kind: "text", value: "fu", truncated: true } }, { fetchFull });
    expect(screen.getByRole("status")).toHaveTextContent("cut-off");
    fireEvent.click(screen.getByRole("button", { name: "Fetch full value" }));
    await waitFor(() => expect(docText()).toBe("full text"));
  });

  it("loads a file into a bytes cell as a staged edit with the new size (spec: data-grid › Load a file)", async () => {
    const file = new Uint8Array(2 * 1024 * 1024).fill(7);
    const loadFile = vi.fn(async () => file);
    const { props } = mount({ value: bytes("00") }, { loadFile });
    fireEvent.click(screen.getByRole("button", { name: "Load file…" }));
    await waitFor(() => expect(props.onStage).toHaveBeenCalledTimes(1));
    const staged = (props.onStage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(staged.kind).toBe("value");
    expect(staged.value).toMatchObject({ kind: "bytes", len: 2 * 1024 * 1024 });
    expect(await screen.findByText(/Staged 2\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/Nothing is written until you submit/)).toBeInTheDocument();
  });

  it("does nothing when the file dialog is cancelled (spec: data-grid › Load a file)", async () => {
    const { props } = mount({ value: bytes("00") });
    fireEvent.click(screen.getByRole("button", { name: "Load file…" }));
    await waitFor(() => expect(props.loadFile).toHaveBeenCalled());
    expect(props.onStage).not.toHaveBeenCalled();
  });

  it("shows an empty state without a selection (spec: data-grid › Value editor panel)", () => {
    render(
      <ValueEditorPanel
        cell={null}
        editable
        onStage={() => {}}
        loadFile={async () => null}
        saveFile={async () => {}}
      />,
    );
    expect(screen.getByText("Select a cell to see its value.")).toBeInTheDocument();
  });
});
