import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import type { ColumnMeta, Value } from "../../../lib/ipc/drivers";
import type { ResultEditor } from "../../results/ResultEditor";
import { ChangeSet } from "../../table-editor/changeSet";
import type { GridHandle } from "../ResultGrid";
import { sourceOf } from "../source";
import { CELLS_MIME, buildCopy } from "./clipboard";
import { usePaste } from "./usePaste";

const meta = (name: string, kind: ColumnMeta["kind"]): ColumnMeta => ({
  name,
  type_name: kind,
  kind,
  nullable: null,
});
const t = (s: string): Value => ({ kind: "text", value: s });
const i = (n: number): Value => ({ kind: "int", value: n });
const columns = [
  meta("id", "int"),
  meta("status", "text"),
  meta("total", "int"),
  meta("calc", "text"),
];

function makeRows(n: number): Value[][] {
  return Array.from({ length: n }, (_, r) => [i(r + 1), t(`s${r}`), i(r * 10), t("x")]);
}

interface Fixture {
  cs: ChangeSet;
  editor: ResultEditor;
  notify: Mock<(message: string) => void>;
}

function fixture(rows = 4, opts: { canAdd?: boolean; readOnly?: boolean } = {}): Fixture {
  const cs = new ChangeSet(sourceOf(columns, makeRows(rows)));
  const editable = !opts.readOnly;
  const editor = {
    changes: cs,
    editable,
    resolution: editable
      ? {
          kind: "editable",
          columns: columns.map(() => ({ editable: true, reason: null, nullable: true })),
          keyIndexes: [0],
          candidates: [{}],
        }
      : { kind: "readOnly", reason: { code: "x", message: "No key column", fix: null } },
    canAddRows: opts.canAdd === false ? { ok: false, reason: "single-table only" } : { ok: true },
    cellState: (col: number, row: number) => {
      if (col === 3) return { editable: false, reason: "Computed" };
      if (col === 0 && row < cs.loadedRows) return { editable: false, reason: "Key" };
      return { editable: true };
    },
  } as unknown as ResultEditor;
  return { cs, editor, notify: vi.fn<(message: string) => void>() };
}

function Harness(p: { f: Fixture; rows: number[]; cols: number[] }) {
  const grid = {
    current: {
      selection: () => ({ rows: p.rows, cols: p.cols }),
      sourceColumns: () => [0, 1, 2, 3],
    } as unknown as GridHandle,
  };
  const x = usePaste({
    editor: p.f.editor,
    grid,
    toStoreRow: (r) => r,
    source: p.f.cs,
    notify: p.f.notify,
  });
  return (
    <div>
      <button onClick={() => x.paste(false)}>do paste</button>
      <button onClick={() => x.paste(true)}>do paste rows</button>
      {x.notice}
      {x.dialogs}
    </div>
  );
}

function clip(text: string, typed?: string) {
  const read = typed
    ? vi.fn().mockResolvedValue([
        {
          types: ["text/plain", CELLS_MIME],
          getType: async (type: string) => new Blob([type === CELLS_MIME ? typed : text]),
        },
      ])
    : undefined;
  Object.assign(navigator, { clipboard: { readText: vi.fn().mockResolvedValue(text), read } });
}

async function pasteBtn(name = "do paste") {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }));
  });
}

const range = (n: number, from = 0) => Array.from({ length: n }, (_, k) => from + k);

afterEach(() => vi.restoreAllMocks());

describe("usePaste", () => {
  it("stages a TSV block over the selection as one undo step (spec: data-grid › One undo)", async () => {
    const f = fixture();
    clip("a\t1\nb\t2\nc\t3");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    expect(f.cs.get(1, 0)).toEqual(t("a"));
    expect(f.cs.get(2, 2)).toEqual(i(3));
    expect(f.cs.get(1, 2)).toEqual(t("c"));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Pasted 3 rows × 2 columns · Tab-separated",
    );
    f.cs.undo();
    expect(f.cs.get(1, 0)).toEqual(t("s0"));
    expect(f.cs.get(2, 2)).toEqual(i(20));
  });

  it("fills a selection with one value (spec: data-grid › One value over a selection)", async () => {
    const f = fixture(6);
    clip("shipped");
    render(<Harness f={f} rows={range(5)} cols={[1]} />);
    await pasteBtn();
    for (let r = 0; r < 5; r++) expect(f.cs.get(1, r)).toEqual(t("shipped"));
    expect(f.cs.get(1, 5)).toEqual(t("s5"));
  });

  it("skips read-only columns and says so (spec: data-grid › Read-only column skipped)", async () => {
    const f = fixture();
    clip("5\tq");
    render(<Harness f={f} rows={[0]} cols={[2]} />);
    await pasteBtn();
    expect(screen.getByRole("status")).toHaveTextContent("1 read-only column skipped");
    expect(f.cs.get(3, 0)).toEqual(t("x"));
  });

  it("lists values that don't fit and stages nothing until chosen (spec: data-grid › Value that doesn't fit)", async () => {
    const f = fixture();
    clip("a\t1\nb\tabc\nc\t3");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    const dlg = await screen.findByRole("dialog");
    expect(within(dlg).getByText("Row 2, total: 'abc' is not a whole number")).toBeInTheDocument();
    expect(f.cs.get(1, 0)).toEqual(t("s0"));
    await act(async () => {
      fireEvent.click(within(dlg).getByRole("button", { name: "Paste the other values" }));
    });
    expect(f.cs.get(1, 0)).toEqual(t("a"));
    expect(f.cs.get(2, 1)).toEqual(i(10));
    expect(f.cs.get(1, 2)).toEqual(t("c"));
    expect(screen.getByRole("status")).toHaveTextContent("1 value skipped");
  });

  it("stages nothing when the invalid-values dialog is cancelled (spec: data-grid › Value that doesn't fit)", async () => {
    const f = fixture();
    clip("a\tnope");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    await act(async () => {
      fireEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }),
      );
    });
    expect(f.cs.get(1, 0)).toEqual(t("s0"));
    expect(f.cs.canUndo).toBe(false);
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers to paste what fits or add the rest (spec: data-grid › More rows than fit)", async () => {
    const f = fixture(4);
    clip(Array.from({ length: 6 }, (_, k) => `n${k}\t${k}`).join("\n"));
    render(<Harness f={f} rows={[2]} cols={[1]} />);
    await pasteBtn();
    const dlg = await screen.findByRole("dialog", { name: "Add 4 new rows?" });
    await act(async () => {
      fireEvent.click(within(dlg).getByRole("button", { name: "Add 4 rows" }));
    });
    expect(f.cs.rowCount).toBe(8);
    expect(f.cs.get(1, 7)).toEqual(t("n5"));
    expect(f.cs.get(1, 3)).toEqual(t("n1"));
    f.cs.undo();
    expect(f.cs.rowCount).toBe(4);
    expect(f.cs.get(1, 2)).toEqual(t("s2"));
  });

  it("can paste only the rows that fit (spec: data-grid › More rows than fit)", async () => {
    const f = fixture(4);
    clip(Array.from({ length: 6 }, (_, k) => `n${k}\t${k}`).join("\n"));
    render(<Harness f={f} rows={[2]} cols={[1]} />);
    await pasteBtn();
    await act(async () => {
      fireEvent.click(await screen.findByRole("button", { name: "Paste 2 rows only" }));
    });
    expect(f.cs.rowCount).toBe(4);
    expect(f.cs.get(1, 3)).toEqual(t("n1"));
  });

  it("adds every pasted row as a new row with Mod+Shift+V (spec: data-grid › Paste as new rows)", async () => {
    const f = fixture(4);
    clip("a\t1\nb\t2\nc\t3");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn("do paste rows");
    expect(f.cs.rowCount).toBe(7);
    expect(f.cs.get(1, 4)).toEqual(t("a"));
    expect(f.cs.get(2, 6)).toEqual(i(3));
    expect(f.cs.get(1, 0)).toEqual(t("s0"));
  });

  it("refuses new rows in a multi-table result", async () => {
    const f = fixture(4, { canAdd: false });
    clip("a\t1");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn("do paste rows");
    expect(f.notify).toHaveBeenCalledWith("single-table only");
    expect(f.cs.rowCount).toBe(4);
  });

  it("redoes the paste with Interpret as (spec: data-grid › Wrong detection)", async () => {
    const f = fixture();
    clip("id;status;total\n1;x;5\n2;y;6");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    expect(screen.getByRole("status")).toHaveTextContent("CSV semicolon");
    expect(f.cs.get(1, 0)).toEqual(t("x"));
    expect(f.cs.get(2, 1)).toEqual(i(6));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Interpret as" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "One value" }));
    });
    // One value: the whole text lands in the anchor cell.
    expect(f.cs.get(1, 0)).toEqual(t("id;status;total\n1;x;5\n2;y;6"));
    expect(screen.getByRole("status")).toHaveTextContent("One value");
    expect(f.cs.undoDepth).toBeLessThanOrEqual(1);
  });

  it("replaces earlier staged values when interpreted differently (spec: data-grid › Wrong detection)", async () => {
    const f = fixture();
    clip("x,1\ny,2");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    expect(screen.getByRole("status")).toHaveTextContent("CSV comma");
    expect(f.cs.get(1, 0)).toEqual(t("x"));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Interpret as" }));
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "CSV semicolon" }));
    });
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("CSV semicolon"));
    expect(f.cs.get(1, 0)).toEqual(t("x,1"));
    expect(f.cs.get(1, 1)).toEqual(t("y,2"));
    expect(f.cs.get(2, 0)).toEqual(i(0));
    expect(f.cs.undoDepth).toBe(1);
  });

  it("undoes from the notice", async () => {
    const f = fixture();
    clip("zz");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    });
    expect(f.cs.get(1, 0)).toEqual(t("s0"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("asks before pasting more than 10,000 cells (spec: data-grid › Large paste)", async () => {
    const f = fixture(10_100);
    clip("big");
    render(<Harness f={f} rows={range(10_001)} cols={[1]} />);
    await pasteBtn();
    const dlg = await screen.findByRole("dialog", { name: "Paste 10,001 cells?" });
    expect(f.cs.get(1, 0)).toEqual(t("s0"));
    await act(async () => {
      fireEvent.click(within(dlg).getByRole("button", { name: "Cancel" }));
    });
    expect(f.cs.canUndo).toBe(false);
    await pasteBtn();
    await act(async () => {
      fireEvent.click(
        within(await screen.findByRole("dialog")).getByRole("button", {
          name: "Paste 10,001 cells",
        }),
      );
    });
    expect(f.cs.get(1, 10_000)).toEqual(t("big"));
  });

  it("refuses more than 100,000 cells (spec: data-grid › Large paste)", async () => {
    const f = fixture(5);
    clip("big");
    render(<Harness f={f} rows={range(100_001)} cols={[1]} />);
    await pasteBtn();
    expect(f.notify).toHaveBeenCalledWith(
      expect.stringContaining("Import the data into the table"),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(f.cs.canUndo).toBe(false);
  });

  it("does nothing in a read-only result and says why", async () => {
    const f = fixture(4, { readOnly: true });
    clip("a");
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    expect(f.notify).toHaveBeenCalledWith("This result is read-only: No key column");
    expect(f.cs.canUndo).toBe(false);
  });

  it("keeps NULL and empty text apart when pasting what Clew copied (spec: data-grid › Copy and paste inside the grid)", async () => {
    const f = fixture();
    const { text, typed } = buildCopy(
      ["status", "total"],
      [
        [{ kind: "null" }, i(7)],
        [t(""), i(8)],
      ],
    );
    clip(text, typed);
    render(<Harness f={f} rows={[0]} cols={[1]} />);
    await pasteBtn();
    expect(f.cs.get(1, 0)).toEqual({ kind: "null" });
    expect(f.cs.get(1, 1)).toEqual(t(""));
    expect(f.cs.get(2, 1)).toEqual(i(8));
    expect(screen.getByRole("status")).toHaveTextContent("· Clew");
  });

  it("asks for a selection first", async () => {
    const f = fixture();
    clip("a");
    render(<Harness f={f} rows={[]} cols={[]} />);
    await pasteBtn();
    expect(f.notify).toHaveBeenCalledWith("Select a cell to paste into first");
  });
});
