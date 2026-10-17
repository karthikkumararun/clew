import { describe, expect, it } from "vitest";
import type { LineEdit } from "./api";
import { applyLineEdits, editStats } from "./lineEdits";

const e = (startLine: number, endLine: number, replacement: string): LineEdit => ({
  startLine,
  endLine,
  replacement,
});

// The same table as `tools::tests::apply_replaces_inserts_and_appends` on the Rust side.
describe("applyLineEdits (parity with src-tauri/src/ai/tools.rs apply)", () => {
  const text = "a\nb\nc";
  it.each([
    [[e(2, 2, "B")], "a\nB\nc"],
    [[e(1, 2, "X\nY\nZ")], "X\nY\nZ\nc"],
    [[e(2, 1, "new")], "a\nnew\nb\nc"],
    [[e(4, 3, "d")], "a\nb\nc\nd"],
    [[e(1, 1, "A"), e(3, 3, "C")], "A\nb\nC"],
    [[e(2, 3, "")], "a"],
    [[e(1, 1, "")], "b\nc"],
    [[e(2, 2, "")], "a\nc"],
  ])("%j", (edits, expected) => {
    expect(applyLineEdits(text, edits)).toBe(expected);
  });

  it("works on a single line and an empty document", () => {
    expect(applyLineEdits("select 1", [e(1, 1, "select 2")])).toBe("select 2");
    expect(applyLineEdits("", [e(1, 1, "select 1")])).toBe("select 1");
    expect(applyLineEdits("", [e(1, 0, "x")])).toBe("x\n");
  });
});

describe("editStats", () => {
  it("counts added and removed lines", () => {
    expect(editStats("a\nb\nc", [e(1, 2, "X\nY\nZ"), e(3, 2, "ins")])).toEqual({
      added: 4,
      removed: 2,
    });
    expect(editStats("a\nb", [e(1, 2, "")])).toEqual({ added: 0, removed: 2 });
  });
});
