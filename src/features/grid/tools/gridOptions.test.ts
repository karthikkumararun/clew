/** Contract: grid options menu, Go to row and Related rows tests. */
import { describe, expect, it } from "vitest";
import { sourceOf } from "../source";
import {
  cellEqualsKey,
  copyQueryText,
  findRowByKey,
  parseGoTo,
  referencedRows,
  referencingRows,
  relatedSelect,
  selectSql,
  viewQueryText,
} from "./gridOptions";
import { NULL, col, dec, int, text } from "./testing";
import { buildVisible } from "./visibleRows";

describe("View query and Copy query", () => {
  it("normalises the statement text (spec: data-grid › Copy query to console)", () => {
    const sel =
      'SELECT * FROM "orders" WHERE "status" = \'shipped\' ORDER BY "id" LIMIT 100 OFFSET 200';
    expect(viewQueryText(`  ${sel} ;; `)).toBe(`${sel};`);
    expect(copyQueryText(sel)).toBe(`${sel};\n`);
    expect(viewQueryText("   ")).toBe("");
    expect(copyQueryText("")).toBe("");
  });

  it("builds a SELECT with the page, filter and order per dialect", () => {
    const p = {
      table: { schema: "public", name: "orders" },
      where: "\"status\" = 'x'",
      orderBy: '"id" DESC',
    };
    expect(selectSql({ ...p, flavor: "postgres", limit: 100, offset: 200 })).toBe(
      'SELECT * FROM "public"."orders" WHERE "status" = \'x\' ORDER BY "id" DESC LIMIT 100 OFFSET 200;',
    );
    expect(selectSql({ flavor: "mysql", table: { name: "t" }, limit: 5 })).toBe(
      "SELECT * FROM `t` LIMIT 5;",
    );
    expect(selectSql({ flavor: "sqlserver", table: { schema: "dbo", name: "t" }, limit: 5 })).toBe(
      "SELECT * FROM [dbo].[t] ORDER BY (SELECT NULL) OFFSET 0 ROWS FETCH NEXT 5 ROWS ONLY;",
    );
    expect(
      selectSql({ flavor: "oracle", table: { name: "t" }, orderBy: '"id"', limit: 5, offset: 10 }),
    ).toBe('SELECT * FROM "t" ORDER BY "id" OFFSET 10 ROWS FETCH NEXT 5 ROWS ONLY;');
    expect(selectSql({ flavor: "sqlite", table: { name: "t" }, columns: ["a", "b"] })).toBe(
      'SELECT "a", "b" FROM "t";',
    );
  });
});

describe("Go to row", () => {
  it("scrolls to a row number, counted from 1 (spec: data-grid › Go to row)", () => {
    expect(parseGoTo("150", { rowCount: 500 })).toEqual({
      ok: true,
      target: { kind: "row", row: 149, clamped: false },
    });
    expect(parseGoTo("#7", { rowCount: 500 })).toMatchObject({ ok: true, target: { row: 6 } });
    expect(parseGoTo("row 2", { rowCount: 500 })).toMatchObject({ ok: true, target: { row: 1 } });
  });

  it("clamps and rejects", () => {
    expect(parseGoTo("9999", { rowCount: 500 })).toEqual({
      ok: true,
      target: { kind: "row", row: 499, clamped: true },
    });
    expect(parseGoTo("0", { rowCount: 500 })).toEqual({
      ok: true,
      target: { kind: "row", row: 0, clamped: true },
    });
    expect(parseGoTo("5", { rowCount: 0 })).toMatchObject({ ok: false });
    expect(parseGoTo("", { rowCount: 5 })).toMatchObject({ ok: false });
    expect(parseGoTo("abc", { rowCount: 5 })).toMatchObject({
      ok: false,
      error: "Enter a row number",
    });
    expect(parseGoTo("abc", { rowCount: 5, keyColumns: 1 })).toMatchObject({ ok: false });
    expect(parseGoTo("key: 5", { rowCount: 5 })).toMatchObject({ ok: false });
  });

  it("finds a key value, also composite, among the visible rows", () => {
    expect(parseGoTo("key: 42", { rowCount: 5, keyColumns: 1 })).toEqual({
      ok: true,
      target: { kind: "key", values: ["42"] },
    });
    expect(parseGoTo("=7, 'a, b'", { rowCount: 5, keyColumns: 2 })).toEqual({
      ok: true,
      target: { kind: "key", values: ["7", "a, b"] },
    });
    expect(parseGoTo("key: 1", { rowCount: 5, keyColumns: 2 })).toMatchObject({ ok: false });

    const s = sourceOf(
      [col("id", "int"), col("tenant"), col("n", "decimal")],
      [
        [int(1), text("a"), dec("1.50")],
        [int(2), text("b"), dec("2")],
        [int(3), text("a"), NULL],
      ],
    );
    expect(findRowByKey(s, null, [0], ["2"])).toBe(1);
    expect(findRowByKey(s, null, [0, 1], ["3", "a"])).toBe(2);
    expect(findRowByKey(s, null, [0, 1], ["3", "b"])).toBe(-1);
    expect(findRowByKey(s, null, [2], ["1.5"])).toBe(0); // exact numeric comparison
    const visible = buildVisible(s, { sort: { column: 0, dir: "desc" } });
    expect(findRowByKey(s, visible, [0], ["1"])).toBe(2); // display row
    expect(
      findRowByKey(
        s,
        buildVisible(s, { filters: [{ column: 1, op: "equals", value: "a" }] }),
        [0],
        ["2"],
      ),
    ).toBe(-1);
    expect(cellEqualsKey(text("x"), "x")).toBe(true);
    expect(cellEqualsKey(NULL, "x")).toBe(false);
  });
});

describe("Related rows", () => {
  const row: Record<string, ReturnType<typeof int>> = { user_id: int(1042), id: int(7) };
  const rowValue = (c: string) => row[c];

  it("opens the referenced users row for a user_id cell (spec: data-grid › Related rows)", () => {
    const r = referencedRows(
      "postgres",
      { columns: ["user_id"], refSchema: "public", refTable: "users", refColumns: ["id"] },
      rowValue,
    );
    expect(r).toEqual({
      ok: true,
      table: { schema: "public", name: "users" },
      sql: 'SELECT * FROM "public"."users" WHERE "id" = 1042;',
    });
  });

  it("opens the child rows that reference a key", () => {
    const r = referencingRows(
      "mysql",
      { schema: "shop", table: "order_items", columns: ["order_id"], refColumns: ["id"] },
      rowValue,
    );
    expect(r).toMatchObject({
      ok: true,
      sql: "SELECT * FROM `shop`.`order_items` WHERE `order_id` = 7;",
    });
  });

  it("handles composite keys, text literals and quoting per dialect", () => {
    const r = relatedSelect(
      "sqlserver",
      { schema: "dbo", name: "child" },
      ["a", "b"],
      [int(1), text("o'k")],
    );
    expect(r).toMatchObject({
      ok: true,
      sql: "SELECT * FROM [dbo].[child] WHERE [a] = 1 AND [b] = 'o''k';",
    });
    expect(relatedSelect("postgres", { name: "c" }, ["a"], [int(1)], 50)).toMatchObject({
      sql: 'SELECT * FROM "c" WHERE "a" = 1 LIMIT 50;',
    });
  });

  it("reports why there is nothing to open", () => {
    expect(relatedSelect("postgres", { name: "c" }, ["a"], [NULL])).toMatchObject({
      ok: false,
      reason: expect.stringContaining("NULL"),
    });
    expect(
      referencedRows(
        "postgres",
        { columns: ["missing"], refTable: "t", refColumns: ["id"] },
        rowValue,
      ),
    ).toMatchObject({ ok: false });
    expect(relatedSelect("postgres", { name: "c" }, ["a", "b"], [int(1)])).toMatchObject({
      ok: false,
    });
  });
});
