import { describe, expect, it } from "vitest";
import { jsonLines } from "./foldModel";
import type { EJson } from "./ejson";

const doc: EJson = {
  _id: { $oid: "6703f1c2a9e41d7c2e0fb812" },
  user: { plan: "pro", beta: true },
  items: [{ sku: "A" }],
  empty: {},
};

const texts = (folded: string[] = []) =>
  jsonLines(doc, "d", new Set(folded)).map((l) => `${" ".repeat(l.depth * 2)}${l.text}`);

describe("jsonLines", () => {
  it("writes shell-syntax JSON with commas between siblings", () => {
    expect(texts()).toEqual([
      "{",
      '  _id: ObjectId("6703f1c2a9e41d7c2e0fb812"),',
      "  user: {",
      '    plan: "pro",',
      "    beta: true",
      "  },",
      "  items: [",
      "    {",
      '      sku: "A"',
      "    }",
      "  ],",
      "  empty: {}",
      "}",
    ]);
  });

  it("collapses a folded object to one summary line", () => {
    const t = texts(['d|["user"]', 'd|["items"]']);
    expect(t).toContain("  user: { … 2 fields },");
    expect(t).toContain("  items: [ … 1 element ],");
    expect(t).not.toContain('    plan: "pro",');
  });

  it("can fold the whole document", () => {
    expect(texts(["d|[]"])).toEqual(["{ … 4 fields }"]);
  });

  it("names the fold each opening line controls", () => {
    const lines = jsonLines(doc, "d", new Set());
    expect(lines[0].fold).toBe("d|[]");
    expect(lines[2].fold).toBe('d|["user"]');
    expect(lines[1].fold).toBeNull();
    expect(lines[lines.length - 1].fold).toBeNull();
  });
});
