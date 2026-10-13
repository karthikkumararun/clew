/** Contract: find, local filter, visibleRows and pending-in-hidden-row tests. */
import { describe, expect, it } from "vitest";
import type { Value } from "../../../lib/ipc/drivers";
import { sourceOf } from "../source";
import {
  compileFind,
  currentMatch,
  findLabel,
  findMatches,
  matchLookup,
  nextMatch,
  prevMatch,
  startFind,
} from "./find";
import {
  filterRows,
  filterSummary,
  hiddenPending,
  hiddenPendingNote,
  parseFilterInput,
} from "./localFilter";
import { NULL, col, dec, int, text } from "./testing";
import {
  VisibleSource,
  buildVisible,
  displayRowOf,
  inverseIndex,
  mapToStoreRow,
} from "./visibleRows";

const columns = [col("id", "int"), col("status"), col("total", "decimal")];
const rows: Value[][] = [
  [int(1), text("shipped"), dec("1150.00")],
  [int(2), text("pending"), dec("300.00")],
  [int(3), text("Shipping"), dec("250.50")],
  [int(4), text("shipped"), dec("100.00")],
  [int(5), NULL, NULL],
  [int(6), text("reshipped"), dec("999.99")],
  [int(7), text("cancelled"), dec("200.00")],
  [int(8), text("ship it"), dec("200.01")],
];
const src = sourceOf(columns, rows);

describe("find on page", () => {
  it("highlights matches, counts them and moves with next/previous (spec: data-grid › Find a value)", () => {
    const result = findMatches(src, null, "ship");
    expect(result.matches.map((m) => [m.row, m.col])).toEqual([
      [0, 1],
      [2, 1],
      [3, 1],
      [5, 1],
      [7, 1],
    ]);
    let s = startFind(result);
    expect(findLabel(s, "ship")).toBe("1 of 5");
    s = nextMatch(nextMatch(s));
    expect(findLabel(s, "ship")).toBe("3 of 5");
    expect(currentMatch(s)).toMatchObject({ row: 3, col: 1 });
    s = prevMatch(s);
    expect(findLabel(s, "ship")).toBe("2 of 5");
    // wraps in both directions
    expect(nextMatch({ ...s, index: 4 }).index).toBe(0);
    expect(prevMatch({ ...s, index: 0 }).index).toBe(4);
    expect(matchLookup(result)(2, 1)).toBe(true);
    expect(matchLookup(result)(1, 1)).toBe(false);
  });

  it("is case-insensitive by default, with case, whole word and regex options", () => {
    const hits = (q: string, o = {}) => findMatches(src, null, q, o).matches.length;
    expect(hits("SHIPPED")).toBe(3);
    expect(hits("SHIPPED", { caseSensitive: true })).toBe(0);
    expect(hits("ship", { wholeWord: true })).toBe(1); // only "ship it"
    expect(hits("shipped", { wholeWord: true })).toBe(2); // not "reshipped"
    expect(hits("ship it", { wholeWord: true })).toBe(1);
    expect(hits("^ship", { regex: true })).toBe(4);
    expect(hits("1.50", { regex: false })).toBe(0);
    expect(hits("\\d{4}\\.00", { regex: true })).toBe(1);
  });

  it("reports an invalid regular expression and handles empty queries", () => {
    const bad = findMatches(src, null, "(", { regex: true });
    expect(bad.error).toBeTruthy();
    expect(findLabel(startFind(bad), "(")).toBe("Invalid pattern");
    expect(compileFind("", {})).toMatchObject({ ok: true });
    expect(findLabel(startFind(findMatches(src, null, "")), "")).toBe("");
    expect(findLabel(startFind(findMatches(src, null, "zzz")), "zzz")).toBe("No results");
  });

  it("searches only visible rows and visible columns, in display order", () => {
    const visible = buildVisible(src, {
      filters: [{ column: 1, op: "contains", value: "ship" }],
      sort: { column: 0, dir: "desc" },
    });
    const r = findMatches(src, visible, "shipped", {}, { columns: [1] });
    expect(r.matches.map((m) => [m.row, m.storeRow])).toEqual([
      [1, 5],
      [2, 3],
      [4, 0],
    ]);
    expect(findMatches(src, visible, "shipped", {}, { columns: [0] }).matches).toHaveLength(0);
  });

  it("starts at the first match at or after the current cell", () => {
    const r = findMatches(src, null, "ship");
    expect(startFind(r, { row: 3, col: 0 }).index).toBe(2);
    expect(startFind(r, { row: 7, col: 2 }).index).toBe(0);
  });
});

describe("local filter", () => {
  it("combines filters with AND (spec: data-grid › Two filters)", () => {
    const status = parseFilterInput("contains ship", "text");
    const total = parseFilterInput("> 200", "decimal");
    expect(status).toEqual({ ok: true, filter: { op: "contains", value: "ship" } });
    expect(total).toEqual({ ok: true, filter: { op: "gt", value: "200" } });
    const rowsOut = filterRows(src, [
      { column: 1, ...(status as { ok: true; filter: object }).filter } as never,
      { column: 2, ...(total as { ok: true; filter: object }).filter } as never,
    ]);
    // shipped 1150, Shipping 250.50, reshipped 999.99, "ship it" 200.01 (pending 300 and 100.00 drop out)
    expect(Array.from(rowsOut)).toEqual([0, 2, 5, 7]);
    expect(filterSummary(rowsOut.length, rows.length)).toBe("Showing 4 of 8 rows");
  });

  it("shows all rows again once filters are cleared (spec: data-grid › Clear)", () => {
    expect(
      Array.from(buildVisible(src, { filters: [{ column: 1, op: "equals", value: "x" }] })),
    ).toEqual([]);
    expect(Array.from(buildVisible(src, { filters: [] }))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(parseFilterInput("   ", "text")).toEqual({ ok: true, filter: null });
  });

  it("supports every operator", () => {
    const f = (column: number, op: string, value?: string, value2?: string) =>
      Array.from(filterRows(src, [{ column, op: op as never, value, value2 }]));
    expect(f(1, "equals", "SHIPPED")).toEqual([0, 3]);
    expect(f(1, "startsWith", "ship")).toEqual([0, 2, 3, 7]);
    expect(f(1, "endsWith", "ped")).toEqual([0, 3, 5]);
    expect(f(1, "isNull")).toEqual([4]);
    expect(f(1, "notNull")).toEqual([0, 1, 2, 3, 5, 6, 7]);
    expect(f(2, "eq", "200")).toEqual([6]);
    expect(f(2, "ne", "200")).toEqual([0, 1, 2, 3, 5, 7]);
    expect(f(2, "lt", "200.01")).toEqual([3, 6]);
    expect(f(2, "le", "200.01")).toEqual([3, 6, 7]);
    expect(f(2, "ge", "999.99")).toEqual([0, 5]);
    expect(f(2, "between", "200", "300")).toEqual([1, 2, 6, 7]);
    expect(f(0, "gt", "6")).toEqual([6, 7]);
  });

  it("parses typed filter text", () => {
    expect(parseFilterInput("starts with a", "text")).toEqual({
      ok: true,
      filter: { op: "startsWith", value: "a" },
    });
    expect(parseFilterInput("ends with z", "text")).toEqual({
      ok: true,
      filter: { op: "endsWith", value: "z" },
    });
    expect(parseFilterInput("not null", "text")).toEqual({ ok: true, filter: { op: "notNull" } });
    expect(parseFilterInput("NULL", "int")).toEqual({ ok: true, filter: { op: "isNull" } });
    expect(parseFilterInput("<> 3", "int")).toEqual({ ok: true, filter: { op: "ne", value: "3" } });
    expect(parseFilterInput("≥ 3", "int")).toEqual({ ok: true, filter: { op: "ge", value: "3" } });
    expect(parseFilterInput("100..200.5", "decimal")).toEqual({
      ok: true,
      filter: { op: "between", value: "100", value2: "200.5" },
    });
    expect(parseFilterInput("between 1 and 2", "int")).toEqual({
      ok: true,
      filter: { op: "between", value: "1", value2: "2" },
    });
    expect(parseFilterInput("42", "int")).toEqual({ ok: true, filter: { op: "eq", value: "42" } });
    expect(parseFilterInput("abc", "text")).toEqual({
      ok: true,
      filter: { op: "contains", value: "abc" },
    });
    expect(parseFilterInput("> abc", "int")).toEqual({ ok: false, error: "'abc' is not a number" });
  });

  it("compares dates as ISO text, a bare date covering the whole day", () => {
    const ts = [col("at", "timestamp")];
    const s = sourceOf(ts, [
      [{ kind: "timestamp", value: "2024-01-05 10:00:00" }],
      [{ kind: "timestamp", value: "2024-01-06 00:00:00" }],
      [{ kind: "timestamp", value: "2024-01-04 23:59:59" }],
    ]);
    const f = (op: string, v: string, v2?: string) =>
      Array.from(filterRows(s, [{ column: 0, op: op as never, value: v, value2: v2 }]));
    expect(f("eq", "2024-01-05")).toEqual([0]);
    expect(f("gt", "2024-01-05")).toEqual([1]);
    expect(f("le", "2024-01-05")).toEqual([0, 2]);
    expect(f("between", "2024-01-05", "2024-01-06")).toEqual([0, 1]);
  });
});

describe("visibleRows", () => {
  it("shares filter and sort, NULLs last either way, stable ties", () => {
    const asc = Array.from(buildVisible(src, { sort: { column: 2, dir: "asc" } }));
    expect(asc).toEqual([3, 6, 7, 2, 1, 5, 0, 4]);
    const desc = Array.from(buildVisible(src, { sort: { column: 2, dir: "desc" } }));
    expect(desc).toEqual([0, 5, 1, 2, 7, 6, 3, 4]);
    const both = buildVisible(src, {
      filters: [{ column: 1, op: "contains", value: "ship" }],
      sort: { column: 2, dir: "asc" },
    });
    expect(Array.from(both)).toEqual([3, 7, 2, 5, 0]);
  });

  it("sorts decimals numerically, not as text", () => {
    const s = sourceOf([col("n", "decimal")], [[dec("9.5")], [dec("10.25")], [dec("100")]]);
    expect(Array.from(buildVisible(s, { sort: { column: 0, dir: "asc" } }))).toEqual([0, 1, 2]);
  });

  it("supports the quick text filter and leaves inserted rows at the end", () => {
    const v = buildVisible(src, { text: "PEND", loadedRows: 6 });
    expect(Array.from(v)).toEqual([1, 6, 7]);
    const v2 = buildVisible(src, { sort: { column: 0, dir: "desc" }, loadedRows: 6 });
    expect(Array.from(v2)).toEqual([5, 4, 3, 2, 1, 0, 6, 7]);
  });

  it("maps display rows to store rows and back", () => {
    const v = buildVisible(src, { sort: { column: 0, dir: "desc" } });
    expect(mapToStoreRow(v, 0)).toBe(7);
    expect(mapToStoreRow(null, 3)).toBe(3);
    expect(displayRowOf(v, 7)).toBe(0);
    const f = buildVisible(src, { filters: [{ column: 0, op: "gt", value: "6" }] });
    expect(displayRowOf(f, 0)).toBe(-1);
    expect(Array.from(inverseIndex(f, 8))).toEqual([-1, -1, -1, -1, -1, -1, 0, 1]);
    const view = new VisibleSource(src, f);
    expect(view.rowCount).toBe(2);
    expect(view.get(0, 0)).toEqual(int(7));
    expect(view.sourceRow(1)).toBe(7);
    expect(view.hiddenCount).toBe(6);
    expect(new VisibleSource(src, null).rowCount).toBe(8);
  });
});

describe("pending changes in hidden rows", () => {
  it("counts hidden rows with pending changes and words the note (spec: data-grid › Two filters)", () => {
    const visible = buildVisible(src, { filters: [{ column: 1, op: "contains", value: "ship" }] });
    // rows 1 (pending) and 6 (cancelled) are hidden; row 0 visible; 8 is an inserted row
    expect(hiddenPending([0, 1, 1, 6, 8], visible, 8)).toBe(2);
    expect(hiddenPending([1], visible, 8)).toBe(1);
    expect(hiddenPending([0], visible, 8)).toBe(0);
    expect(hiddenPending([1], null, 8)).toBe(0);
    expect(hiddenPendingNote(1)).toBe("1 pending change is in a hidden row");
    expect(hiddenPendingNote(2)).toBe("2 pending changes are in hidden rows");
    expect(hiddenPendingNote(0)).toBe("");
  });

  it("keeps the pending rows after filters clear (spec: data-grid › Clear)", () => {
    const pending = [1, 6];
    const filtered = buildVisible(src, {
      filters: [{ column: 1, op: "equals", value: "shipped" }],
    });
    expect(hiddenPending(pending, filtered, 8)).toBe(2);
    expect(hiddenPending(pending, buildVisible(src, {}), 8)).toBe(0);
  });
});
