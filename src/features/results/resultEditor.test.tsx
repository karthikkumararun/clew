import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { QueryRunStore } from "../../lib/ipc/queryRun";
import { RowsSource } from "../grid/source";
import type { ConsoleRuntime } from "../console/runtime";
import type { Candidate, EditResolution } from "./api";
import { EditChip, chooserItems } from "./EditChip";
import { KEY_READONLY_REASON, ResultEditor, describeSubmit } from "./ResultEditor";

const api = vi.hoisted(() => ({
  resolve: vi.fn(),
  refetch: vi.fn(),
  apply: vi.fn(),
  preview: vi.fn(),
}));
vi.mock("./api", async (orig) => ({
  ...(await orig<typeof import("./api")>()),
  resultsResolveEdit: (...a: unknown[]) => api.resolve(...a),
  changesRefetch: (...a: unknown[]) => api.refetch(...a),
}));
vi.mock("../table-editor/api", async (orig) => ({
  ...(await orig<typeof import("../table-editor/api")>()),
  changesApply: (...a: unknown[]) => api.apply(...a),
  changesPreview: (...a: unknown[]) => api.preview(...a),
}));
vi.mock("../safety/ipc", () => import("../safety/ipcMock"));
vi.mock("../../connections/connectionsStore", () => ({
  useConnections: { getState: () => ({ connect: vi.fn().mockResolvedValue(true) }) },
}));

const col = (name: string, kind: ColumnMeta["kind"] = "text"): ColumnMeta => ({
  name,
  type_name: kind === "int" ? "int8" : kind,
  kind,
  nullable: null,
});
const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s, truncated: false });
const set = (v: Value) => ({ kind: "value" as const, value: v });

const orders: Candidate = {
  schema: "public",
  table: "orders",
  available: true,
  missingKeys: [],
  noKey: false,
  isView: false,
};
const users: Candidate = { ...orders, table: "users", available: false, missingKeys: ["id"] };

/** `SELECT id, status, total * 1.2 AS with_tax FROM orders` resolved as editable. */
const editable = (
  extra: Partial<Extract<EditResolution, { kind: "editable" }>> = {},
): EditResolution => ({
  kind: "editable",
  target: { schema: "public", table: "orders" },
  inferred: false,
  columnMap: ["id", "status", null],
  keyColumns: ["id"],
  keyIndexes: [0],
  columns: [
    { editable: true, reason: null, nullable: false, hasDefault: true },
    { editable: true, reason: null, nullable: true, hasDefault: false },
    { editable: false, reason: "Computed column", nullable: true, hasDefault: false },
  ],
  candidates: [orders],
  ...extra,
});

async function fixture(
  resolution: EditResolution = editable(),
  txMode: "auto" | "manual" = "auto",
) {
  const results = new QueryRunStore();
  results.apply({
    event: "columns",
    result_id: 1,
    statement: 0,
    columns: [col("id", "int"), col("status"), col("with_tax", "int")],
  } as never);
  const rows: Value[][] = [
    [int(1), text("pending"), int(120)],
    [int(2), text("paid"), int(240)],
  ];
  results.apply({ event: "rows", result_id: 1, rows } as never);
  results.apply({
    event: "done",
    result_id: 1,
    summary: { rows_affected: null, elapsed_ms: 1, has_more: false },
  } as never);
  await Promise.resolve(); // the run store publishes its snapshot on a microtask
  const runtime = {
    connectionId: "c1",
    txMode,
    results,
    store: { setState: vi.fn() },
    ensureSession: vi.fn().mockResolvedValue("s1"),
    recordSubmit: vi.fn(),
    rerun: vi.fn().mockResolvedValue(undefined),
  } as unknown as ConsoleRuntime;
  const view = results.getSnapshot().results[0];
  const base = new RowsSource(view.columns, view.rows);
  api.resolve.mockResolvedValue(resolution);
  const editor = new ResultEditor(
    runtime,
    view.key,
    base,
    "SELECT id, status FROM orders",
    "postgres",
  );
  return { editor, runtime, results, rows, base };
}

beforeEach(() => {
  Object.values(api).forEach((m) => m.mockReset());
  api.apply.mockResolvedValue({ applied: 1, failure: null, transactionOpen: false });
  api.preview.mockResolvedValue([
    { kind: "update", sql: "UPDATE orders SET status = 'x'", target: { kind: "update", index: 0 } },
  ]);
  api.refetch.mockResolvedValue([[int(1), text("shipped")]]);
});

describe("the edit chip (spec: result-editing › Read-only reasons)", () => {
  const chip = (resolution: EditResolution | null, extra = {}) =>
    render(
      <EditChip
        resolution={resolution}
        resolving={false}
        error={null}
        locked={false}
        onChoose={vi.fn()}
        onSwitchToReadWrite={vi.fn()}
        {...extra}
      />,
    );

  it("names the table and key of an editable result (spec: result-editing › Single table with its key)", () => {
    chip(editable());
    expect(screen.getByRole("button", { name: "Editing table orders, key id" })).toHaveTextContent(
      "Editing public.orders· key id",
    );
  });

  it("says no primary key is in the result and names it (spec: result-editing › Key missing)", () => {
    chip({
      kind: "readOnly",
      reason: {
        code: "noKeyInResult",
        message: "No primary key in the result for orders. Add id to the SELECT.",
        fix: "Add id to the SELECT",
      },
      candidates: [orders],
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "No primary key in the result for orders. Add id to the SELECT.",
    );
  });

  it("offers Switch to read-write on a read-only production session (spec: result-editing › Read-only production session)", () => {
    const onSwitch = vi.fn();
    chip(
      {
        kind: "readOnly",
        reason: {
          code: "sessionReadOnly",
          message: "This session is read-only (PRODUCTION)",
          fix: "Switch to read-write",
        },
        candidates: [],
      },
      { onSwitchToReadWrite: onSwitch },
    );
    fireEvent.click(screen.getByRole("button", { name: "Switch to read-write" }));
    expect(onSwitch).toHaveBeenCalled();
  });

  it("states that a table without a key can't identify rows (spec: result-editing › No key anywhere)", () => {
    chip({
      kind: "readOnly",
      reason: {
        code: "noKeyOnTable",
        message: "orders has no primary or unique key, so its rows can't be identified.",
        fix: null,
      },
      candidates: [{ ...orders, available: false, noKey: true }],
    });
    expect(screen.getByRole("status")).toHaveTextContent("can't be identified");
  });

  it("lists available and unavailable tables in a join and offers Choose table (spec: result-editing › Two candidates)", () => {
    const onChoose = vi.fn();
    chip(editable({ candidates: [orders, { ...users, available: true, missingKeys: [] }] }), {
      onChoose,
    });
    fireEvent.click(screen.getByRole("button", { name: /Editing table orders.*Change table/ }));
    const menu = screen.getByRole("menu", { name: "Choose table" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: /public\.users/ }));
    expect(onChoose).toHaveBeenCalledWith({ schema: "public", table: "users" });
  });

  it("shows the key an unavailable table misses (spec: result-editing › One candidate)", () => {
    const items = chooserItems([orders, users], { schema: "public", table: "orders" });
    expect(items[1]).toMatchObject({ disabled: true, hint: "key missing (add users.id)" });
    expect(items[0].disabled).toBe(false);
  });

  it("does not offer a chooser for a single table, and locks it while changes are pending", () => {
    const { rerender } = chip(editable());
    expect(screen.getByRole("button", { name: "Editing table orders, key id" })).toBeDisabled();
    rerender(
      <EditChip
        resolution={editable({ candidates: [orders, users] })}
        resolving={false}
        error={null}
        locked
        onChoose={vi.fn()}
        onSwitchToReadWrite={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: /Change table/ })).toBeDisabled();
  });
});

describe("what can be edited (spec: result-editing › Editing cells)", () => {
  it("key cells of loaded rows are read-only, new rows may set them (spec: result-editing › Key columns of existing rows)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    expect(editor.cellState(0, 0)).toEqual({ editable: false, reason: KEY_READONLY_REASON });
    const row = editor.addRow()!;
    expect(editor.cellState(0, row).editable).toBe(true);
  });

  it("expression columns stay read-only with their reason (spec: result-editing › Expression columns stay read-only)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    expect(editor.cellState(2, 0)).toEqual({ editable: false, reason: "Computed column" });
    editor.stage(2, 0, set(int(1)));
    expect(editor.pendingCount).toBe(0);
  });

  it("hides Set NULL for NOT NULL columns (spec: result-editing › Set NULL on a NOT NULL column)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    expect(editor.canSetNull(0)).toBe(false);
    expect(editor.canSetNull(1)).toBe(true);
  });

  it("stages a change of status and counts one pending change (spec: result-editing › Change a cell)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    editor.stage(1, 0, set(text("shipped")));
    expect(editor.changes!.counts()).toMatchObject({ edited: 1, total: 1 });
  });
});

describe("adding, cloning and deleting rows (spec: result-editing › Adding, cloning and deleting rows)", () => {
  it("a new row leaves the key to DEFAULT and sets NULL elsewhere", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    const row = editor.addRow()!;
    expect(editor.changes!.get(0, row)).toMatchObject({ value: "DEFAULT" }); // key: database default
    expect(editor.changes!.get(1, row)).toEqual({ kind: "null" });
  });

  it("clones a row with an auto-numbered key as DEFAULT (spec: result-editing › Clone)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    const [clone] = editor.cloneRows([0]);
    expect(editor.changes!.get(1, clone)).toEqual(text("pending"));
    expect(editor.changes!.get(0, clone)).toMatchObject({ value: "DEFAULT" });
    expect(editor.changes!.counts().inserted).toBe(1);
  });

  it("deleting stages the removal and nothing is removed yet (spec: result-editing › Delete)", async () => {
    const { editor, rows } = await fixture();
    await editor.resolve();
    editor.deleteRows([0, 1]);
    expect(editor.changes!.counts().deleted).toBe(2);
    expect(rows).toHaveLength(2);
  });

  it("refuses Add row in a joined result (spec: result-editing › Add row in a join)", async () => {
    const { editor } = await fixture(
      editable({ candidates: [orders, { ...users, available: true, missingKeys: [] }] }),
    );
    await editor.resolve();
    expect(editor.canAddRows).toEqual({
      ok: false,
      reason: "Rows can only be added to single-table results",
    });
    expect(editor.addRow()).toBeNull();
  });

  it("explains how many result rows show a deleted table row (spec: result-editing › Delete in a join)", async () => {
    const { editor, results } = await fixture();
    await editor.resolve();
    results.patchRows(editor.resultKey, (r) => r.push([int(1), text("pending"), int(120)]));
    expect(editor.deleteInfo([0])).toEqual({ tableRows: 1, resultRows: 2 });
  });

  it("tells that a key appears several times in the result (spec: result-editing › Fan-out join)", async () => {
    const { editor, results } = await fixture();
    await editor.resolve();
    results.patchRows(editor.resultKey, (r) => r.push([int(1), text("pending"), int(120)]));
    expect(editor.sharedNotice(0)).toBe(
      "Order 1 appears 2 times in this result. An edit applies to all 2.",
    );
    editor.stage(1, 0, set(text("shipped")));
    expect(editor.changes!.get(1, 2)).toEqual(text("shipped"));
    expect(editor.changes!.counts().edited).toBe(1);
  });

  it("revert selected puts only those cells back (spec: result-editing › Revert selected)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    editor.stage(1, 0, set(text("a")));
    editor.stage(1, 1, set(text("b")));
    editor.revertCells([{ col: 1, row: 0 }]);
    expect(editor.changes!.counts().edited).toBe(1);
    expect(editor.changes!.get(1, 0)).toEqual(text("pending"));
  });
});

describe("submit (spec: result-editing › Submit and transactions)", () => {
  it("auto-commit: applies, reads the row back, clears the markers (spec: result-editing › Auto-commit submit)", async () => {
    const { editor, runtime, rows } = await fixture();
    await editor.resolve();
    editor.stage(1, 0, set(text("shipped")));
    expect(await editor.submit()).toBe(true);
    const request = api.apply.mock.calls[0][2];
    expect(request.manual).toBe(false);
    expect(request.edits[0].key).toEqual([int(1)]);
    expect(editor.pendingCount).toBe(0);
    expect(rows[0][1]).toEqual(text("shipped")); // read back
    expect(
      (runtime as unknown as { recordSubmit: ReturnType<typeof vi.fn> }).recordSubmit,
    ).toHaveBeenCalled();
  });

  it("manual mode: stays in the open transaction and says so (spec: result-editing › Manual mode submit)", async () => {
    api.apply.mockResolvedValue({ applied: 1, failure: null, transactionOpen: true });
    const { editor } = await fixture(editable(), "manual");
    await editor.resolve();
    editor.stage(1, 0, set(text("shipped")));
    await editor.submit();
    expect(api.apply.mock.calls[0][2].manual).toBe(true);
    expect(editor.store.getState().sent).toBe(
      "Sent to the open transaction: 1 UPDATE. Not saved until you commit.",
    );
  });

  it("submit and commit asks the backend to commit (spec: result-editing › Submit and commit)", async () => {
    const { editor } = await fixture(editable(), "manual");
    await editor.resolve();
    editor.stage(1, 0, set(text("shipped")));
    await editor.submit({ commit: true });
    expect(api.apply.mock.calls[0][2].commitAfter).toBe(true);
    expect(editor.store.getState().sent).toBeNull();
  });

  it("a failure keeps every change staged and names the row (spec: result-editing › Failure keeps the transaction)", async () => {
    api.apply.mockResolvedValue({
      applied: 0,
      failure: {
        target: { kind: "update", index: 0 },
        message: "null value violates not-null",
        conflict: false,
      },
      transactionOpen: true,
    });
    const { editor } = await fixture(editable(), "manual");
    await editor.resolve();
    editor.stage(1, 1, set(text("x")));
    expect(await editor.submit()).toBe(false);
    expect(editor.pendingCount).toBe(1);
    expect(editor.store.getState().submitError).toMatchObject({
      message: "null value violates not-null",
      row: 1,
      conflict: false,
    });
  });

  it("a changed row is a conflict; Reload row drops the edit and shows the database value (spec: result-editing › Row changed by someone else)", async () => {
    api.apply.mockResolvedValue({
      applied: 0,
      failure: { target: { kind: "update", index: 0 }, message: "changed", conflict: true },
      transactionOpen: false,
    });
    const { editor, rows } = await fixture();
    await editor.resolve();
    editor.stage(1, 0, set(text("shipped")));
    await editor.submit();
    expect(editor.store.getState().submitError?.conflict).toBe(true);
    api.refetch.mockResolvedValue([[int(1), text("cancelled")]]);
    await editor.reloadRow(0);
    expect(editor.pendingCount).toBe(0);
    expect(rows[0][1]).toEqual(text("cancelled"));
  });

  it("Overwrite stages the edit again over the current values and submits (spec: result-editing › Row changed by someone else)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    editor.stage(1, 0, set(text("shipped")));
    api.refetch.mockResolvedValue([[int(1), text("cancelled")]]);
    expect(await editor.overwrite(0)).toBe(true);
    const request = api.apply.mock.calls[0][2];
    // the old value is now what the database holds, so the optimistic check matches
    expect(request.edits[0].changes[0].old).toEqual(text("cancelled"));
    expect(request.edits[0].changes[0].new).toEqual(set(text("shipped")));
  });

  it("marks computed columns out of date after an edit (spec: result-editing › Stale computed column)", async () => {
    const { editor } = await fixture();
    await editor.resolve();
    editor.stage(1, 0, set(text("shipped")));
    await editor.submit();
    expect(editor.isStale(2, 0)).toBe(true);
    expect(editor.isStale(2, 1)).toBe(false);
  });

  it("reads the result again when rows were inserted so their keys show (spec: result-editing › Generated key appears)", async () => {
    const { editor, runtime } = await fixture();
    await editor.resolve();
    editor.addRow();
    editor.stage(1, 2, set(text("new")));
    await editor.submit();
    expect((runtime as unknown as { rerun: ReturnType<typeof vi.fn> }).rerun).toHaveBeenCalled();
  });
});

describe("describing a submit", () => {
  it("lists the statements by kind", () => {
    const req = { edits: [1, 2, 3], inserts: [1], deletes: [1] } as never;
    expect(describeSubmit(req, true)).toBe(
      "Sent to the open transaction: 3 UPDATE, 1 INSERT, 1 DELETE. Not saved until you commit.",
    );
    expect(describeSubmit(req, false)).toBe("Applied: 3 UPDATE, 1 INSERT, 1 DELETE.");
  });
});
