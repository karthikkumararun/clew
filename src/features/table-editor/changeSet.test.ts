import { describe, expect, it, vi } from "vitest";
import type { ColumnMeta, NodePath, Value } from "../../lib/ipc/drivers";
import { sourceOf } from "../grid/source";
import { ChangeSet } from "./changeSet";
import { editText, parseEdit } from "./editValue";

const col = (name: string, kind: ColumnMeta["kind"], type_name: string = kind): ColumnMeta => ({
  name,
  type_name,
  kind,
  nullable: null,
});
const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s });
const set = (v: Value) => ({ kind: "value" as const, value: v });

function fixture() {
  const base = sourceOf(
    [col("id", "int", "int8"), col("status", "text"), col("note", "text")],
    [
      [int(1), text("pending"), { kind: "null" }],
      [int(2), text("shipped"), text("fast")],
      [int(3), text("pending"), { kind: "null" }],
    ],
  );
  return new ChangeSet(base);
}
const PATH: NodePath = [{ kind: "table", name: "orders" }];

describe("ChangeSet", () => {
  it("shows edits over the loaded rows and counts rows, not cells", () => {
    const c = fixture();
    c.setCell(0, 1, set(text("shipped")));
    c.setCell(0, 2, set(text("hi")));
    expect(c.get(1, 0)).toEqual(text("shipped"));
    expect(c.original(1, 0)).toEqual(text("pending"));
    expect(c.rowState(0)).toBe("edited");
    expect(c.isEdited(1, 0)).toBe(true);
    expect(c.isEdited(0, 0)).toBe(false);
    expect(c.counts()).toEqual({ edited: 1, inserted: 0, deleted: 0, total: 1 });
  });

  it("drops an edit that writes the loaded value back", () => {
    const c = fixture();
    c.setCell(0, 1, set(text("shipped")));
    c.setCell(0, 1, set(text("pending")));
    expect(c.rowState(0)).toBeUndefined();
    expect(c.counts().total).toBe(0);
  });

  it("undoes and redoes one step at a time", () => {
    const c = fixture();
    c.setCell(0, 1, set(text("a")));
    c.setCell(1, 1, set(text("b")));
    expect(c.counts().edited).toBe(2);
    expect(c.undo()).toBe(true);
    expect(c.counts().edited).toBe(1);
    expect(c.get(1, 1)).toEqual(text("shipped"));
    expect(c.redo()).toBe(true);
    expect(c.get(1, 1)).toEqual(text("b"));
    expect(c.redo()).toBe(false);
    c.undo();
    c.setCell(2, 1, set(text("c"))); // a new change ends the redo line
    expect(c.canRedo).toBe(false);
  });

  it("adds rows after the loaded ones; unset columns show DEFAULT", () => {
    const c = fixture();
    const row = c.addRow();
    expect(row).toBe(3);
    expect(c.rowCount).toBe(4);
    expect(c.rowState(row)).toBe("inserted");
    expect(c.get(1, row)).toMatchObject({ kind: "other", value: "DEFAULT" });
    c.setCell(row, 1, set(text("new")));
    expect(c.get(1, row)).toEqual(text("new"));
    c.deleteRows([row]);
    expect(c.rowCount).toBe(3);
    expect(c.counts().total).toBe(0);
  });

  it("marks loaded rows deleted and restores them on a second delete", () => {
    const c = fixture();
    c.setCell(1, 1, set(text("x")));
    c.deleteRows([1, 2]);
    expect(c.counts()).toEqual({ edited: 0, inserted: 0, deleted: 2, total: 2 });
    expect(c.rowState(1)).toBe("deleted");
    c.setCell(1, 1, set(text("ignored")));
    expect(c.get(1, 1)).toEqual(text("x"));
    c.deleteRows([1, 2]);
    expect(c.counts().deleted).toBe(0);
  });

  it("revert all clears everything, history included", () => {
    const c = fixture();
    c.setCell(0, 1, set(text("a")));
    c.addRow();
    c.clear();
    expect(c.counts().total).toBe(0);
    expect(c.canUndo).toBe(false);
    expect(c.rowCount).toBe(3);
  });

  it("notifies subscribers and changes its version", () => {
    const c = fixture();
    const fn = vi.fn();
    const off = c.subscribe(fn);
    const v = c.version;
    c.setCell(0, 1, set(text("a")));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(c.version).not.toBe(v);
    off();
    c.undo();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("builds the request keyed by the loaded key values, with the old values", () => {
    const c = fixture();
    c.setCell(1, 1, set(text("returned")));
    c.setCell(1, 2, { kind: "default" });
    c.setCell(0, 2, set({ kind: "null" })); // null -> null is no change
    c.deleteRows([2]);
    const row = c.addRow();
    c.setCell(row, 1, set(text("fresh")));
    const req = c.request(PATH, ["id"]);
    expect(req.keyColumns).toEqual(["id"]);
    expect(req.columns[0]).toEqual({ name: "id", type_name: "int8" });
    expect(req.edits).toEqual([
      {
        key: [int(2)],
        changes: [
          { column: "status", old: text("shipped"), new: set(text("returned")) },
          { column: "note", old: text("fast"), new: { kind: "default" } },
        ],
      },
    ]);
    expect(req.inserts).toEqual([{ values: [{ column: "status", value: set(text("fresh")) }] }]);
    expect(req.deletes).toEqual([{ key: [int(3)] }]);
  });

  it("does not update a row that is also being deleted", () => {
    const c = fixture();
    c.setCell(0, 1, set(text("a")));
    c.deleteRows([0]);
    const req = c.request(PATH, ["id"]);
    expect(req.edits).toEqual([]);
    expect(req.deletes).toHaveLength(1);
    expect(c.counts()).toMatchObject({ edited: 0, deleted: 1 });
  });

  it("maps a failed statement back to its row", () => {
    const c = fixture();
    c.setCell(2, 1, set(text("a")));
    c.setCell(0, 1, set(text("b")));
    c.deleteRows([1]);
    const row = c.addRow();
    expect(c.rowOfTarget("update", 0)).toBe(0);
    expect(c.rowOfTarget("update", 1)).toBe(2);
    expect(c.rowOfTarget("delete", 0)).toBe(1);
    expect(c.rowOfTarget("insert", 0)).toBe(row);
    expect(c.rowOfTarget("insert", 4)).toBeNull();
  });
});

describe("parsing typed values", () => {
  it("parses integers, falling back to bigint past 2^53", () => {
    expect(parseEdit({ kind: "int" }, " 42 ")).toEqual({ ok: true, value: int(42) });
    expect(parseEdit({ kind: "int" }, "9007199254740993")).toEqual({
      ok: true,
      value: { kind: "bigint", value: "9007199254740993" },
    });
    expect(parseEdit({ kind: "int" }, "4.5")).toMatchObject({ ok: false });
  });

  it("parses decimals, floats and booleans", () => {
    expect(parseEdit({ kind: "decimal" }, "12.50")).toEqual({
      ok: true,
      value: { kind: "decimal", value: "12.50" },
    });
    expect(parseEdit({ kind: "decimal" }, "abc")).toMatchObject({ ok: false });
    expect(parseEdit({ kind: "float" }, "1e3")).toEqual({
      ok: true,
      value: { kind: "float", value: 1000 },
    });
    expect(parseEdit({ kind: "float" }, "")).toMatchObject({ ok: false });
    expect(parseEdit({ kind: "bool" }, "T")).toEqual({
      ok: true,
      value: { kind: "bool", value: true },
    });
    expect(parseEdit({ kind: "bool" }, "maybe")).toMatchObject({ ok: false });
  });

  it("validates JSON and keeps it structured", () => {
    expect(parseEdit({ kind: "json" }, '{"a": [1]}')).toEqual({
      ok: true,
      value: { kind: "json", value: { a: [1] } },
    });
    const bad = parseEdit({ kind: "json" }, "{oops");
    expect(bad.ok).toBe(false);
  });

  it("keeps dates and uuids as typed text; plain text is untouched", () => {
    expect(parseEdit({ kind: "date" }, "2026-01-02")).toEqual({
      ok: true,
      value: { kind: "date", value: "2026-01-02" },
    });
    expect(parseEdit({ kind: "date" }, " ")).toMatchObject({ ok: false });
    expect(parseEdit({ kind: "text" }, "  keep me ")).toEqual({
      ok: true,
      value: text("  keep me "),
    });
  });

  it("starts the editor from the current value", () => {
    expect(editText({ kind: "null" })).toBe("");
    expect(editText(text("x"))).toBe("x");
    expect(editText({ kind: "json", value: { a: 1 } })).toBe('{\n  "a": 1\n}');
    expect(editText(int(7))).toBe("7");
    expect(editText({ kind: "other", value: "DEFAULT", type_name: "default" })).toBe("");
  });
});
