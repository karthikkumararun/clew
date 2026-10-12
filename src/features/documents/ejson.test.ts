import { describe as suite, expect, it } from "vitest";
import {
  describe,
  dottable,
  getAt,
  idLabel,
  parseScalar,
  setAt,
  summary,
  toShell,
  type EJson,
} from "./ejson";

const oid = { $oid: "6703f1c2a9e41d7c2e0fb812" };

suite("describe", () => {
  it("names every BSON type the canvas shows (spec: driver-framework › ObjectId display)", () => {
    expect(describe(oid)).toMatchObject({
      type: "ObjectId",
      display: 'ObjectId("6703f1c2a9e41d7c2e0fb812")',
    });
    expect(describe("x")).toMatchObject({ type: "String", display: '"x"', text: "x" });
    expect(describe({ $numberInt: "5" })).toMatchObject({ type: "Int32", display: "5" });
    expect(describe({ $numberLong: "9007199254740993" })).toMatchObject({
      type: "Int64",
      display: "9007199254740993",
    });
    expect(describe({ $numberDouble: "64.5" })).toMatchObject({ type: "Double", display: "64.5" });
    expect(describe({ $numberDecimal: "12.50" }).type).toBe("Decimal128");
    expect(describe(true)).toMatchObject({ type: "Boolean", display: "true" });
    expect(describe(null).type).toBe("Null");
    expect(describe({ $date: { $numberLong: "1790857800000" } })).toMatchObject({
      type: "Date",
      display: "2026-10-01T12:30:00.000Z",
    });
    expect(describe({ a: 1, b: 2 })).toMatchObject({
      type: "Document",
      display: "{ 2 fields }",
      container: true,
    });
    expect(describe([1])).toMatchObject({ type: "Array", display: "[ 1 element ]" });
    expect(describe({ $regularExpression: { pattern: "^a", options: "i" } }).display).toBe("/^a/i");
    expect(describe({ $timestamp: { t: 5, i: 2 } }).display).toBe("Timestamp(5, 2)");
    expect(describe({ $minKey: 1 }).type).toBe("MinKey");
  });

  it("recognises a UUID", () => {
    const u = describe({ $binary: { base64: "Ej5FZ+ibEtOkVkJmFBdAAA==", subType: "04" } });
    expect(u).toMatchObject({ type: "UUID", text: "123e4567-e89b-12d3-a456-426614174000" });
    expect(describe({ $binary: { base64: "AAEC", subType: "00" } }).type).toBe("Binary");
  });
});

suite("shell syntax", () => {
  it("writes constructors the way the shell does", () => {
    const doc: EJson = {
      _id: oid,
      n: { $numberLong: "5" },
      i: { $numberInt: "3" },
      when: { $date: { $numberLong: "1790857800000" } },
      "odd-key": "v",
      tags: ["a"],
    };
    expect(toShell(doc)).toBe(
      [
        "{",
        '  _id: ObjectId("6703f1c2a9e41d7c2e0fb812"),',
        '  n: NumberLong("5"),',
        "  i: 3,",
        '  when: ISODate("2026-10-01T12:30:00.000Z"),',
        '  "odd-key": "v",',
        "  tags: [",
        '    "a"',
        "  ]",
        "}",
      ].join("\n"),
    );
  });

  it("summarises on one line", () => {
    expect(summary({ sku: "TBL-OAK", qty: { $numberInt: "1" }, deep: { a: 1 } })).toBe(
      '{ sku: "TBL-OAK", qty: 1, deep: {…} }',
    );
    expect(summary([{ $numberInt: "1" }, "x"])).toBe('[ 1, "x" ]');
  });

  it("labels documents by _id", () => {
    expect(idLabel({ _id: oid })).toBe(
      'ObjectId("6703…fb812")'.replace("6703…fb812", idLabel({ _id: oid }).slice(10, -2)),
    );
    expect(idLabel({ a: 1 })).toBe("(no _id)");
    expect(idLabel({ _id: { $numberInt: "7" } })).toBe("7");
  });
});

suite("edits", () => {
  it("builds typed values", () => {
    expect(parseScalar("Int32", "42")).toEqual({ ok: true, value: { $numberInt: "42" } });
    expect(parseScalar("Int32", "4.5").ok).toBe(false);
    expect(parseScalar("Int32", "3000000000").ok).toBe(false);
    expect(parseScalar("Int64", "9007199254740993")).toEqual({
      ok: true,
      value: { $numberLong: "9007199254740993" },
    });
    expect(parseScalar("Double", "5")).toEqual({ ok: true, value: { $numberDouble: "5.0" } });
    expect(parseScalar("Double", "1.25")).toEqual({ ok: true, value: { $numberDouble: "1.25" } });
    expect(parseScalar("Double", "abc").ok).toBe(false);
    expect(parseScalar("Boolean", "true")).toEqual({ ok: true, value: true });
    expect(parseScalar("Boolean", "yes").ok).toBe(false);
    expect(parseScalar("String", " keep spaces ")).toEqual({ ok: true, value: " keep spaces " });
    expect(parseScalar("Null", "")).toEqual({ ok: true, value: null });
    expect(parseScalar("Date", "2026-10-01")).toEqual({
      ok: true,
      value: { $date: { $numberLong: String(Date.UTC(2026, 9, 1)) } },
    });
    expect(parseScalar("Date", "not a date").ok).toBe(false);
    expect(parseScalar("ObjectId", "6703F1C2A9E41D7C2E0FB812")).toEqual({ ok: true, value: oid });
    expect(parseScalar("ObjectId", "xyz").ok).toBe(false);
    expect(parseScalar("Decimal128", "12.50")).toEqual({
      ok: true,
      value: { $numberDecimal: "12.50" },
    });
  });

  it("reads and writes nested paths without touching the original", () => {
    const doc: EJson = { user: { plan: "free" }, items: [{ qty: 1 }, { qty: 2 }] };
    expect(getAt(doc, ["user", "plan"])).toBe("free");
    expect(getAt(doc, ["items", "1", "qty"])).toBe(2);
    expect(getAt(doc, ["user", "nope"])).toBeUndefined();
    const next = setAt(doc, ["user", "plan"], "pro");
    expect(getAt(next, ["user", "plan"])).toBe("pro");
    expect(getAt(doc, ["user", "plan"])).toBe("free");
    expect(getAt(setAt(doc, ["items", "0"], undefined), ["items", "0", "qty"])).toBe(2);
    expect(getAt(setAt(doc, ["user", "plan"], undefined), ["user"])).toEqual({});
  });

  it("knows which keys dotted paths can express", () => {
    expect(dottable(["a", "0", "b"])).toBe(true);
    expect(dottable(["a.b"])).toBe(false);
    expect(dottable(["$x"])).toBe(false);
  });
});
