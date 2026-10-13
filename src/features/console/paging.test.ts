import { describe, expect, it } from "vitest";
import { sourceOf } from "../grid/source";
import { PagedSource, lastPlan, nextPage, pageLabel, pageWindow } from "./paging";

describe("result paging (spec: sql-console › Result paging)", () => {
  it("Next on page 1 of a 5,000 row result with page size 500 shows rows 501–1,000 (spec: sql-console › Next page)", () => {
    // 1,000 rows loaded so far of a larger result, page 1 (0-based 0) showing 1–500
    expect(pageLabel(0, 500, 1_000)).toBe("1–500");
    const next = nextPage(0, 500, 1_000, true)!;
    expect(next).toEqual({ page: 1, need: 0 });
    expect(pageLabel(next.page, 500, 1_000)).toBe("501–1,000");
  });

  it("asks the open cursor for the rows a page needs", () => {
    expect(nextPage(1, 500, 1_000, true)).toEqual({ page: 2, need: 500 });
    expect(nextPage(1, 500, 1_000, false)).toBeNull(); // nothing left
    expect(nextPage(0, 500, 700, false)).toEqual({ page: 1, need: 0 });
  });

  it("clamps the last, partly filled page", () => {
    expect(pageWindow(2, 500, 1_200)).toEqual({ from: 1_000, to: 1_200 });
    expect(pageLabel(2, 500, 1_200)).toBe("1,001–1,200");
    expect(pageLabel(0, 500, 0)).toBe("0");
  });

  it("Last confirms when it must load a million rows first (spec: sql-console › Last page of a large result)", () => {
    expect(lastPlan(500, 500, true, 1_000_000)).toEqual({
      confirm: true,
      known: false,
      page: null,
    });
    expect(lastPlan(500, 500, true, 5_000).confirm).toBe(false);
    expect(lastPlan(500, 1_200, false)).toEqual({ confirm: false, known: true, page: 2 });
    expect(lastPlan(500, 150_000, true).confirm).toBe(true); // total unknown, already big
  });

  it("a paged source is a window over the rows", () => {
    const src = sourceOf(
      [{ name: "n", type_name: "int", kind: "int", nullable: null }],
      Array.from({ length: 7 }, (_, i) => [{ kind: "int" as const, value: i }]),
    );
    const page = new PagedSource(src, 5, 3);
    expect(page.rowCount).toBe(2);
    expect(page.get(0, 0)).toEqual({ kind: "int", value: 5 });
    const v = page.version;
    page.from = 0;
    expect(page.version).not.toBe(v);
  });
});
