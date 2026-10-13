import { describe, expect, it } from "vitest";
import type { ColumnMeta, NodePath, Value } from "../../lib/ipc/drivers";
import { sourceOf } from "../grid/source";
import { ChangeSet } from "../table-editor/changeSet";

const col = (name: string, kind: ColumnMeta["kind"], type_name: string = kind): ColumnMeta => ({
  name,
  type_name,
  kind,
  nullable: null,
});
const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s });
const set = (v: Value) => ({ kind: "value" as const, value: v });
const PATH: NodePath = [{ kind: "table", name: "orders" }];

/** `SELECT total AS amount, id AS order_id, total * 1.2 AS with_tax FROM orders` */
function aliased() {
  const base = sourceOf(
    [col("amount", "int", "numeric"), col("order_id", "int", "int8"), col("with_tax", "int")],
    [
      [int(100), int(1), int(120)],
      [int(250), int(2), int(300)],
    ],
  );
  return new ChangeSet(base, { columnMap: ["total", "id", null], keyIndexes: [1] });
}

describe("editing a result through column aliases (spec: result-editing › Aliased and reordered columns)", () => {
  it("an edit of amount updates orders.total keyed by order_id", () => {
    const c = aliased();
    c.setCell(0, 0, set(int(130)));
    const req = c.request(PATH, ["id"]);
    expect(req.keyColumns).toEqual(["id"]);
    expect(req.edits).toEqual([
      { key: [int(1)], changes: [{ column: "total", old: int(100), new: set(int(130)) }] },
    ]);
    // only table columns are sent; the expression column has no table column
    expect(req.columns.map((x) => x.name)).toEqual(["total", "id"]);
  });

  it("an edit of an unmapped column writes nothing", () => {
    const c = aliased();
    c.setCell(0, 2, set(int(999)));
    expect(c.request(PATH, ["id"]).edits[0].changes).toEqual([]);
  });

  it("deletes are keyed by the key column's alias", () => {
    const c = aliased();
    c.deleteRows([1]);
    expect(c.request(PATH, ["id"]).deletes).toEqual([{ key: [int(2)] }]);
  });
});

describe("rows that show the same table row (spec: result-editing › Fan-out join)", () => {
  /** order 88213 on three result rows (a join that fans out), plus order 5 once */
  function fanOut() {
    const base = sourceOf(
      [col("id", "int"), col("status", "text"), col("item", "text")],
      [
        [int(88213), text("pending"), text("a")],
        [int(88213), text("pending"), text("b")],
        [int(88213), text("pending"), text("c")],
        [int(5), text("pending"), text("d")],
      ],
    );
    return new ChangeSet(base, { columnMap: ["id", "status", null], keyIndexes: [0] });
  }

  it("mirrors an edit into every row, counts it once and generates one statement", () => {
    const c = fanOut();
    c.setCell(1, 1, set(text("shipped")));
    expect([0, 1, 2].map((r) => c.get(1, r))).toEqual([
      text("shipped"),
      text("shipped"),
      text("shipped"),
    ]);
    expect(c.get(1, 3)).toEqual(text("pending"));
    expect(c.counts().edited).toBe(1);
    expect(c.sharedRows(0)).toEqual([0, 1, 2]);
    const req = c.request(PATH, ["id"]);
    expect(req.edits).toHaveLength(1);
    expect(req.edits[0].key).toEqual([int(88213)]);
  });

  it("undoing the edit restores all rows", () => {
    const c = fanOut();
    c.setCell(0, 1, set(text("shipped")));
    c.undo();
    expect([0, 1, 2].map((r) => c.get(1, r))).toEqual([
      text("pending"),
      text("pending"),
      text("pending"),
    ]);
  });

  it("deleting one of the rows deletes the table row once", () => {
    const c = fanOut();
    c.deleteRows([2]);
    expect(c.counts().deleted).toBe(1);
    expect([0, 1, 2].map((r) => c.rowState(r))).toEqual(["deleted", "deleted", "deleted"]);
    expect(c.request(PATH, ["id"]).deletes).toEqual([{ key: [int(88213)] }]);
  });
});

describe("the table editor keeps its identity mapping", () => {
  it("without a mapping, rows are independent and columns keep their names", () => {
    const base = sourceOf(
      [col("id", "int"), col("status", "text")],
      [
        [int(1), text("a")],
        [int(1), text("a")],
      ],
    );
    const c = new ChangeSet(base);
    c.setCell(0, 1, set(text("b")));
    expect(c.get(1, 1)).toEqual(text("a"));
    expect(c.request(PATH, ["id"]).edits[0].changes[0].column).toBe("status");
  });
});
