import { describe, expect, it } from "vitest";
import { docsToTable, toGridValue } from "./tableModel";
import type { EJson } from "./ejson";

const int = (n: number) => ({ $numberInt: String(n) });

describe("docsToTable", () => {
  const docs: EJson[] = [
    { a: int(1), _id: { $oid: "6703f1c2a9e41d7c2e0fb812" }, name: "x" },
    { _id: { $oid: "6703ee09a9e41d7c2e0fa771" }, name: "y", extra: { $numberDouble: "1.5" } },
  ];

  it("puts _id first and keeps first-seen order after it", () => {
    expect(docsToTable(docs).columns.map((c) => c.name)).toEqual(["_id", "a", "name", "extra"]);
  });

  it("types a column by its values, and calls mixed ones mixed", () => {
    const t = docsToTable([{ n: int(1) }, { n: "text" }, { n: int(2) }]);
    expect(t.columns[0]).toMatchObject({ type_name: "mixed", kind: "text" });
    const u = docsToTable(docs);
    expect(u.columns.find((c) => c.name === "a")).toMatchObject({
      type_name: "Int32",
      kind: "int",
    });
    expect(u.columns.find((c) => c.name === "extra")).toMatchObject({ kind: "float" });
  });

  it("fills missing fields with null", () => {
    const t = docsToTable(docs);
    expect(t.rows[1][t.columns.findIndex((c) => c.name === "a")]).toEqual({ kind: "null" });
  });

  it("shows nested values as one-line summaries", () => {
    expect(toGridValue({ sku: "A", qty: int(1) })).toEqual({
      kind: "text",
      value: '{ sku: "A", qty: 1 }',
    });
    expect(toGridValue([int(1), int(2)])).toEqual({ kind: "text", value: "[ 1, 2 ]" });
  });

  it("keeps 64-bit integers exact", () => {
    expect(toGridValue({ $numberLong: "9007199254740993" })).toEqual({
      kind: "bigint",
      value: "9007199254740993",
    });
    expect(toGridValue({ $numberLong: "42" })).toEqual({ kind: "int", value: 42 });
  });
});
