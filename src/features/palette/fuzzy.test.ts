import { describe, expect, it } from "vitest";
import { fuzzyMatch, highlightRuns } from "./fuzzy";

describe("fuzzyMatch (spec: command-palette › Fuzzy search)", () => {
  it("needs every character in order, ignoring case", () => {
    expect(fuzzyMatch("ORD", "orders")?.indices).toEqual([0, 1, 2]);
    expect(fuzzyMatch("odr", "orders")?.indices).toEqual([0, 2, 4]);
    expect(fuzzyMatch("dro", "orders")).toBeNull();
  });

  it("ranks an exact prefix above a word-boundary match above a scattered one", () => {
    const prefix = fuzzyMatch("ord", "orders")!;
    const boundary = fuzzyMatch("ord", "Export orders to CSV")!;
    const scattered = fuzzyMatch("ord", "Open recent database")!;
    expect(prefix.score).toBeGreaterThan(boundary.score);
    expect(boundary.score).toBeGreaterThan(scattered.score);
  });

  it("treats camelCase and separators as word starts", () => {
    expect(fuzzyMatch("ref", "carts.orderRef")!.score).toBeGreaterThan(
      fuzzyMatch("ref", "preferences")!.score,
    );
  });

  it("matches everything for an empty query", () => {
    expect(fuzzyMatch("  ", "anything")).toEqual({ score: 0, indices: [] });
  });
});

describe("highlightRuns", () => {
  it("splits text into matched and plain runs", () => {
    expect(highlightRuns("orders", [0, 1, 2])).toEqual([
      { text: "ord", hit: true },
      { text: "ers", hit: false },
    ]);
    expect(highlightRuns("abc", [])).toEqual([{ text: "abc", hit: false }]);
  });
});
