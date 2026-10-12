import { describe, expect, it } from "vitest";
import { lintSource } from "./check-tokens";

describe("token lint (spec: design-conformance › Token conformance)", () => {
  it("fails a hard-coded colour and names the file and line (spec: design-conformance › Hard-coded colour)", () => {
    const css = ".a {\n  color: var(--text);\n  background: #F2766B;\n}\n";
    const v = lintSource("src/x/X.module.css", css);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: "src/x/X.module.css", line: 3 });
  });

  it("catches rgb(), hsl() and hex in TypeScript strings", () => {
    expect(lintSource("a.tsx", 'const s = { color: "rgb(1, 2, 3)" };')).toHaveLength(1);
    expect(lintSource("a.tsx", 'const c = "hsla(0 0% 0% / .5)";')).toHaveLength(1);
    expect(lintSource("a.ts", 'const c = "#fff";')).toHaveLength(1);
  });

  it("allows tokens, comments and ids", () => {
    expect(
      lintSource("a.css", "a { color: var(--accent); } /* #fff */\n#root { margin: 0 }"),
    ).toEqual([]);
    expect(lintSource("a.ts", "// see #fff\nconst x = 1;")).toEqual([]);
  });

  it("allows only the font tokens", () => {
    expect(lintSource("a.css", "a { font-family: var(--font-mono); }")).toEqual([]);
    expect(lintSource("a.css", "a { font-family: Arial, sans-serif; }")).toHaveLength(1);
  });
});
