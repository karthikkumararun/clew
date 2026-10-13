import { describe, expect, it } from "vitest";
import type { ColumnMeta, Value } from "../../../lib/ipc/drivers";
import { sourceOf } from "../source";
import { ChangeSet } from "../../table-editor/changeSet";
import { stage } from "./adapter";
import { plan } from "./plan";
import type { PasteColumn } from "./plan";

const meta = (name: string, kind: ColumnMeta["kind"]): ColumnMeta => ({
  name,
  type_name: kind,
  kind,
  nullable: null,
});
const t = (s: string): Value => ({ kind: "text", value: s });
const i = (n: number): Value => ({ kind: "int", value: n });
const pc: PasteColumn[] = [
  { name: "id", kind: "int", nullable: null, editable: true },
  { name: "status", kind: "text", nullable: null, editable: true },
  { name: "total", kind: "int", nullable: null, editable: true },
];

function fixture() {
  return new ChangeSet(
    sourceOf(
      [meta("id", "int"), meta("status", "text"), meta("total", "int")],
      [
        [i(1), t("a"), i(10)],
        [i(2), t("b"), i(20)],
        [i(3), t("c"), i(30)],
      ],
    ),
  );
}

describe("stage", () => {
  it("a 3x2 paste is one undo step (spec: data-grid › One undo)", () => {
    const cs = fixture();
    const p = plan(
      [
        ["x", "1"],
        ["y", "2"],
        ["z", "3"],
      ],
      { row: 0, col: 1, rows: 1, cols: 1 },
      pc,
      true,
      { rowCount: 3 },
    );
    const s = stage(p, cs);
    expect(s.cells).toBe(6);
    expect(s.grouped).toBe(true);
    expect(cs.get(1, 2)).toEqual(t("z"));
    expect(cs.counts().edited).toBe(3);
    expect(cs.undo()).toBe(true);
    expect(cs.counts().total).toBe(0);
    expect(cs.get(1, 0)).toEqual(t("a"));
    expect(cs.get(2, 2)).toEqual(i(30));
    expect(cs.canUndo).toBe(false);
    expect(cs.redo()).toBe(true);
    expect(cs.get(1, 2)).toEqual(t("z"));
  });

  it("keeps earlier undo steps intact (spec: data-grid › One undo)", () => {
    const cs = fixture();
    cs.setCell(0, 1, { kind: "value", value: t("first") });
    const p = plan([["x"], ["y"]], { row: 1, col: 1, rows: 1, cols: 1 }, pc, true, { rowCount: 3 });
    stage(p, cs);
    cs.undo();
    expect(cs.get(1, 0)).toEqual(t("first"));
    expect(cs.get(1, 1)).toEqual(t("b"));
    cs.undo();
    expect(cs.get(1, 0)).toEqual(t("a"));
  });

  it("adds extra rows only on request, in the same undo step (spec: data-grid › More rows than fit)", () => {
    const rows = [["a"], ["b"], ["c"], ["d"]];
    const opts = { rowCount: 3, canAddRows: true };
    const p = plan(rows, { row: 2, col: 1, rows: 1, cols: 1 }, pc, true, opts);
    const only = fixture();
    expect(stage(p, only).rowsAdded).toBe(0);
    expect(only.rowCount).toBe(3);
    const all = fixture();
    const s = stage(p, all, { includeExtraRows: true });
    expect(s.rowsAdded).toBe(3);
    expect(all.rowCount).toBe(6);
    expect(all.get(1, 5)).toEqual(t("d"));
    all.undo();
    expect(all.rowCount).toBe(3);
    expect(all.counts().total).toBe(0);
  });

  it("Mod+Shift+V rows are added (spec: data-grid › Paste as new rows)", () => {
    const cs = fixture();
    const p = plan([["a"], ["b"], ["c"]], { row: 0, col: 1, rows: 1, cols: 1 }, pc, true, {
      rowCount: 3,
      asNewRows: true,
      canAddRows: true,
    });
    stage(p, cs);
    expect(cs.counts().inserted).toBe(3);
    expect(cs.rowState(3)).toBe("inserted");
    expect(cs.get(1, 4)).toEqual(t("b"));
  });

  it("handle undo works once and only while nothing came after (Interpret as)", () => {
    const cs = fixture();
    const mk = (v: string) =>
      plan([[v]], { row: 0, col: 1, rows: 1, cols: 1 }, pc, true, { rowCount: 3 });
    const s = stage(mk("x"), cs);
    expect(s.undo()).toBe(true);
    expect(cs.get(1, 0)).toEqual(t("a"));
    expect(s.undo()).toBe(false);
    const s2 = stage(mk("y"), cs);
    cs.setCell(1, 1, { kind: "value", value: t("later") });
    expect(s2.undo()).toBe(false);
  });

  it("an empty plan stages nothing", () => {
    const cs = fixture();
    const s = stage(plan([], { row: 0, col: 0, rows: 1, cols: 1 }, pc, true, { rowCount: 3 }), cs);
    expect(s.cells).toBe(0);
    expect(cs.canUndo).toBe(false);
    expect(s.undo()).toBe(false);
  });
});
