import { describe, expect, it } from "vitest";
import type { Value } from "../../../lib/ipc/drivers";
import { detect } from "./detect";
import { plan } from "./plan";
import type { PasteColumn } from "./plan";

const col = (
  name: string,
  kind: PasteColumn["kind"],
  extra: Partial<PasteColumn> = {},
): PasteColumn => ({ name, kind, nullable: true, editable: true, ...extra });
const COLS = [
  col("id", "int", { editable: false }),
  col("status", "text"),
  col("total", "decimal"),
  col("note", "text"),
];
const sel = (row: number, c: number, rows = 1, cols = 1) => ({ row, col: c, rows, cols });
const text = (s: string): Value => ({ kind: "text", value: s });
const dec = (s: string): Value => ({ kind: "decimal", value: s });
const base = { rowCount: 10 };

describe("plan", () => {
  it("maps a header by name, whatever the order (spec: data-grid › CSV with header)", () => {
    const d = detect(
      "total,Status,other\n10.50,shipped,x\n3,open,y\n",
      COLS.map((c) => c.name),
    );
    const p = plan(d.table, sel(4, 3), COLS, true, { ...base, hasHeader: d.hasHeader });
    expect(p.mapping).toBe("header");
    expect(p.unmatchedHeaders).toEqual(["other"]);
    expect(p.assignments).toEqual([
      { row: 4, col: 2, value: dec("10.50") },
      { row: 4, col: 1, value: text("shipped") },
      { row: 5, col: 2, value: dec("3") },
      { row: 5, col: 1, value: text("open") },
    ]);
    expect(p.colsPasted).toBe(2);
  });

  it("JSON keys map to columns by name (spec: data-grid › JSON array)", () => {
    const d = detect('[{"status":"shipped","total":10}]');
    const p = plan(d.table, sel(0, 0), COLS, true, { ...base, hasHeader: d.hasHeader });
    expect(p.assignments).toEqual([
      { row: 0, col: 1, value: text("shipped") },
      { row: 0, col: 2, value: dec("10") },
    ]);
  });

  it("maps by position from the selection and drops a non-matching header (spec: data-grid › Copy and paste inside the grid)", () => {
    const p = plan(
      [
        ["s1", "5"],
        ["s2", "6"],
      ],
      sel(2, 1),
      COLS,
      true,
      base,
    );
    expect(p.mapping).toBe("position");
    expect(p.assignments.map((a) => [a.row, a.col])).toEqual([
      [2, 1],
      [2, 2],
      [3, 1],
      [3, 2],
    ]);
    const h = plan(
      [
        ["x", "y"],
        ["s1", "5"],
      ],
      sel(0, 1),
      COLS,
      true,
      { ...base, hasHeader: true },
    );
    expect(h.mapping).toBe("position");
    expect(h.assignments).toHaveLength(2);
  });

  it("fills a selection with one value (spec: data-grid › One value over a selection)", () => {
    const p = plan([["shipped"]], sel(0, 1, 5, 1), COLS, true, base);
    expect(p.assignments).toHaveLength(5);
    expect(p.assignments.every((a) => a.col === 1 && a.value.kind === "text")).toBe(true);
  });

  it("tiles an exact multiple and fills from the top-left otherwise (spec: data-grid › One value over a selection)", () => {
    const tbl = [["a"], ["b"]];
    const tiled = plan(tbl, sel(0, 1, 4, 1), COLS, true, base);
    expect(tiled.assignments.map((a) => (a.value as { value: string }).value)).toEqual([
      "a",
      "b",
      "a",
      "b",
    ]);
    const odd = plan(tbl, sel(0, 1, 3, 1), COLS, true, base);
    expect(odd.assignments).toHaveLength(2);
  });

  it("skips read-only columns and reports them (spec: data-grid › Read-only column skipped)", () => {
    const p = plan([["9", "shipped"]], sel(0, 0), COLS, true, base);
    expect(p.skippedColumns).toEqual([{ col: 0, name: "id" }]);
    expect(p.assignments).toEqual([{ row: 0, col: 1, value: text("shipped") }]);
    const none = plan([["x"]], sel(0, 1), COLS, false, base);
    expect(none.assignments).toEqual([]);
    expect(none.skippedColumns).toHaveLength(1);
  });

  it("lists values that do not fit and keeps the others (spec: data-grid › Value that doesn't fit)", () => {
    const p = plan(
      [
        ["ok", "10"],
        ["ok2", "abc"],
      ],
      sel(2, 1),
      COLS,
      true,
      base,
    );
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toMatchObject({ row: 3, col: 2, column: "total", raw: "abc" });
    expect(p.errors[0].message).toBe("Row 4, total: 'abc' is not a number");
    expect(p.assignments).toHaveLength(3);
  });

  it("keeps exact decimals as strings and parses other kinds with the editors' rules", () => {
    const cols = [col("a", "decimal"), col("b", "int"), col("c", "bool"), col("d", "json")];
    const p = plan(
      [["12345678901234567890.123456789", "7", "yes", '{"x":1}']],
      sel(0, 0),
      cols,
      true,
      base,
    );
    expect(p.assignments.map((a) => a.value)).toEqual([
      dec("12345678901234567890.123456789"),
      { kind: "int", value: 7 },
      { kind: "bool", value: true },
      { kind: "json", value: { x: 1 } },
    ]);
  });

  it("accepts decimal commas from semicolon CSV only", () => {
    const cols = [col("a", "decimal")];
    const semi = plan([["1,5"]], sel(0, 0), cols, true, { ...base, format: "semicolon" });
    expect(semi.assignments[0].value).toEqual(dec("1.5"));
    const csv = plan([["1,5"]], sel(0, 0), cols, true, base);
    expect(csv.errors).toHaveLength(1);
  });

  it("NULL and empty rules", () => {
    const cols = [col("t", "text"), col("n", "int"), col("r", "int", { nullable: false })];
    const p = plan(
      [
        ["", "", "5"],
        ["NULL", "null", ""],
      ],
      sel(0, 0),
      cols,
      true,
      base,
    );
    const at = (r: number, c: number) =>
      p.assignments.find((a) => a.row === r && a.col === c)?.value;
    expect(at(0, 0)).toEqual(text(""));
    expect(at(0, 1)).toEqual({ kind: "null" });
    expect(at(1, 0)).toEqual({ kind: "null" });
    expect(at(1, 1)).toEqual({ kind: "null" });
    expect(p.errors).toHaveLength(1);
    expect(p.errors[0]).toMatchObject({ row: 1, col: 2 });
  });

  it("rows beyond the grid become extra rows (spec: data-grid › More rows than fit)", () => {
    const tbl = Array.from({ length: 6 }, (_, i) => [`s${i}`]);
    const p = plan(tbl, sel(8, 1), COLS, true, { rowCount: 10, canAddRows: true });
    expect(p.rowsFit).toBe(2);
    expect(p.assignments).toHaveLength(2);
    expect(p.extraRows).toHaveLength(4);
    expect(p.extraRows[0].cells).toEqual([{ col: 1, value: text("s2") }]);
    const no = plan(tbl, sel(8, 1), COLS, true, { rowCount: 10 });
    expect(no.extraRows).toEqual([]);
    expect(no.droppedRows).toBe(4);
  });

  it("Mod+Shift+V puts every row in newRows (spec: data-grid › Paste as new rows)", () => {
    const p = plan(
      [
        ["a", "1"],
        ["b", "2"],
        ["c", "3"],
      ],
      sel(0, 1),
      COLS,
      true,
      {
        ...base,
        asNewRows: true,
        canAddRows: true,
      },
    );
    expect(p.assignments).toEqual([]);
    expect(p.newRows).toHaveLength(3);
    expect(p.newRows![2].cells).toEqual([
      { col: 1, value: text("c") },
      { col: 2, value: dec("3") },
    ]);
  });

  it("limits: confirm over 10,000 cells, refuse over 100,000 (spec: data-grid › Large paste)", () => {
    const big = (rows: number) => Array.from({ length: rows }, () => ["a", "b"]);
    const ok = plan(big(5000), sel(0, 1), COLS, true, { rowCount: 5000 });
    expect(ok.cells).toBe(10_000);
    expect(ok.limit).toBeNull();
    const confirm = plan(big(5001), sel(0, 1), COLS, true, { rowCount: 5001 });
    expect(confirm.limit).toBe("confirm");
    expect(confirm.assignments.length).toBeGreaterThan(0);
    const refuse = plan(big(50_001), sel(0, 1), COLS, true, { rowCount: 50_001 });
    expect(refuse.limit).toBe("refuse");
    expect(refuse.assignments).toEqual([]);
  });

  it("typed values keep NULL vs empty string and exact decimals", () => {
    const rows: Value[][] = [
      [text(""), dec("0.10")],
      [{ kind: "null" }, { kind: "null" }],
    ];
    const p = plan(rows, sel(0, 1), COLS, true, base);
    expect(p.assignments.map((a) => a.value)).toEqual([
      text(""),
      dec("0.10"),
      { kind: "null" },
      { kind: "null" },
    ]);
  });
});
