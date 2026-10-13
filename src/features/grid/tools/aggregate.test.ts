/** Contract: aggregate tests, one per spec scenario plus the exactness and async cases. */
import { describe, expect, it, vi } from "vitest";
import {
  ASYNC_THRESHOLD,
  aggregate,
  aggregateAsync,
  aggregateClipboardText,
  aggregateSelection,
  formatAggregate,
} from "./aggregate";
import { scaleFromTypeName } from "./decimal";
import { NULL, dec, flt, int, text } from "./testing";

describe("aggregate", () => {
  it("sums decimals exactly (spec: data-grid › Selected numbers)", () => {
    const r = aggregate([dec("1150.00"), dec("300.00")]);
    expect(r).toMatchObject({
      count: 2,
      numericCount: 2,
      sum: "1450.00",
      avg: "725.00",
      min: "300.00",
      max: "1150.00",
      approximate: false,
    });
    expect(formatAggregate(r)).toBe(
      "2 cells · COUNT 2 · SUM 1,450.00 · AVG 725.00 · MIN 300.00 · MAX 1,150.00",
    );
  });

  it("never uses floating point for decimals: 0.1 + 0.2 = 0.3", () => {
    const r = aggregate([dec("0.1"), dec("0.2")]);
    expect(r.sum).toBe("0.3");
    expect(r.avg).toBe("0.15");
    expect(r.approximate).toBe(false);
  });

  it("averages decimals exactly and rounds only past the scale plus six digits", () => {
    expect(aggregate([dec("10.00"), dec("0.01"), dec("0.02")]).avg).toBe("3.34333333");
    expect(aggregate([int(1), int(2)]).avg).toBe("1.5");
    expect(aggregate([int(1), int(2), int(3)]).avg).toBe("2");
    expect(aggregate([dec("-1.00"), dec("-2.00")]).avg).toBe("-1.50");
  });

  it("keeps bigints exact beyond 2^53", () => {
    const r = aggregate([
      { kind: "bigint", value: "9007199254740993" },
      { kind: "bigint", value: "2" },
    ]);
    expect(r.sum).toBe("9007199254740995");
  });

  it("mixes scales and honours the column type's scale", () => {
    expect(aggregate([dec("1.5"), dec("2.25"), int(1)]).sum).toBe("4.75");
    expect(
      aggregate([int(1), int(2)], { scale: scaleFromTypeName("numeric(10,2)") ?? 0 }).sum,
    ).toBe("3.00");
  });

  it("flags floats as approximate and uses doubles", () => {
    const r = aggregate([flt(0.1), flt(0.2)]);
    expect(r.approximate).toBe(true);
    expect(r.sum).toBe("0.3");
    expect(formatAggregate(r)).toContain("SUM ≈ 0.3");
    expect(aggregate([flt(1.5), dec("2.5")]).approximate).toBe(true);
  });

  it("shows only the cell count for text (spec: data-grid › No numbers)", () => {
    const r = aggregate([text("a"), text("b"), NULL]);
    expect(r).toMatchObject({ count: 3, numericCount: 0, sum: null, nullCount: 1, distinct: 2 });
    expect(formatAggregate(r)).toBe("3 cells");
    expect(aggregateClipboardText(r)).toBeNull();
    // non-numeric still gives distinct / null count / text min and max
    expect(r.minText).toBe("a");
    expect(r.maxText).toBe("b");
    expect(formatAggregate(r, { extended: true })).toBe(
      "3 cells · DISTINCT 2 · NULLS 1 · MIN a · MAX b",
    );
  });

  it("ignores NULL and non-numeric cells in the numeric aggregates", () => {
    const r = aggregate([int(2), NULL, text("x"), int(4)]);
    expect(r).toMatchObject({ count: 4, numericCount: 2, sum: "6", avg: "3" });
  });

  it("copies the SUM for Mod+Shift+C", () => {
    const r = aggregate([dec("1150.00"), dec("300.00")]);
    expect(aggregateClipboardText(r)).toBe("1450.00");
    expect(aggregateClipboardText(r, { group: true })).toBe("1,450.00");
  });
});

describe("aggregateAsync", () => {
  const cells = (n: number) => Array.from({ length: n }, (_, i) => int(i + 1));

  it("chunks a 150k-cell selection and yields between chunks (spec: data-grid › Selected numbers)", async () => {
    const yieldNow = vi.fn(() => Promise.resolve());
    const progress = vi.fn();
    const n = 150_000;
    expect(n).toBeGreaterThan(ASYNC_THRESHOLD);
    const r = await aggregateSelection(cells(n), n, {
      chunk: 20_000,
      yieldNow,
      onProgress: progress,
    });
    expect(yieldNow).toHaveBeenCalledTimes(7);
    expect(progress).toHaveBeenLastCalledWith(n);
    expect(r.sum).toBe("11250075000");
    expect(r.count).toBe(n);
    expect(r.max).toBe("150000");
  });

  it("matches the sync result and skips yielding for small selections", async () => {
    const yieldNow = vi.fn(() => Promise.resolve());
    const small = cells(1000);
    const viaSelection = await aggregateSelection(small, small.length, { yieldNow });
    expect(yieldNow).not.toHaveBeenCalled();
    expect(viaSelection).toEqual(aggregate(small));
    expect(await aggregateAsync(small, { chunk: 100, yieldNow })).toEqual(aggregate(small));
  });

  it("can be cancelled", async () => {
    const ctl = new AbortController();
    const p = aggregateAsync(cells(1000), {
      chunk: 100,
      yieldNow: () => {
        ctl.abort();
        return Promise.resolve();
      },
      signal: ctl.signal,
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
  });
});
