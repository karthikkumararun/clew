import { describe, expect, it } from "vitest";
import { splitStatements, statementAt } from "./statements";
import type { SplitDialect } from "./statements";

// The corpus shared with the Rust splitter (src-tauri/src/drivers/split.rs).
const files = import.meta.glob("../../../../src-tauri/tests/fixtures/split/*", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const fixtures = Object.keys(files)
  .filter((p) => p.endsWith(".sql"))
  .map((p) => ({
    name: p.split("/").pop()!,
    sql: files[p],
    expected: JSON.parse(files[p.replace(/\.sql$/, ".expected.json")]) as {
      dialect: SplitDialect;
      statements: string[];
    },
  }));

describe("shared split fixtures", () => {
  it("found the corpus", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(6);
  });

  it.each(fixtures)("$name", ({ sql, expected }) => {
    expect(splitStatements(sql, expected.dialect).map((s) => s.text)).toEqual(expected.statements);
  });

  it("ranges point at the statement text in the source", () => {
    for (const { sql, expected } of fixtures) {
      for (const r of splitStatements(sql, expected.dialect)) {
        expect(sql.slice(r.from, r.to)).toBe(r.text);
      }
    }
  });
});

describe("blank lines (editor)", () => {
  const text = "select 1\nfrom a\n\nselect 2\n  \n\nselect 3";
  it("end a statement when no semicolon does", () => {
    expect(splitStatements(text, null, { blankLines: true }).map((s) => s.text)).toEqual([
      "select 1\nfrom a",
      "select 2",
      "select 3",
    ]);
  });

  it("are ignored by the server-side rules", () => {
    expect(splitStatements(text, null).map((s) => s.text)).toEqual([text]);
  });

  it("don't split inside strings, comments, dollar quotes or BEGIN … END", () => {
    const pg = "select 'a\n\nb';\nDO $$\nbegin\n\n  null;\nend\n$$;\n/* x\n\ny */ select 1";
    const got = splitStatements(pg, "postgresql", { blankLines: true }).map((s) => s.text);
    expect(got).toEqual([
      "select 'a\n\nb'",
      "DO $$\nbegin\n\n  null;\nend\n$$",
      "/* x\n\ny */ select 1",
    ]);
    const trig = "CREATE TRIGGER t AFTER INSERT ON o\nBEGIN\n  select 1;\n\n  select 2;\nEND;";
    expect(splitStatements(trig, "sqlite", { blankLines: true })).toHaveLength(1);
  });

  it("keeps ranges exact with CRLF line endings", () => {
    const crlf = "select 1\r\n\r\nselect 2";
    const r = splitStatements(crlf, null, { blankLines: true });
    expect(r.map((s) => s.text)).toEqual(["select 1", "select 2"]);
    expect(crlf.slice(r[1].from, r[1].to)).toBe("select 2");
  });
});

describe("leading comments (editor)", () => {
  it("start a statement at its first token", () => {
    const sql = "-- top customers\n/* more */\nSELECT 1;\n# note\nSELECT 2 -- tail";
    const got = splitStatements(sql, null, { skipLeadingComments: true });
    expect(got.map((s) => s.text)).toEqual(["SELECT 1", "# note\nSELECT 2 -- tail"]);
    expect(sql.slice(got[0].from, got[0].to)).toBe("SELECT 1");
    const my = splitStatements(sql, "mysql", { skipLeadingComments: true });
    expect(my.map((s) => s.text)).toEqual(["SELECT 1", "SELECT 2 -- tail"]);
  });

  it("drop a segment that is only comments", () => {
    expect(
      splitStatements("-- nothing\n;select 1", null, { skipLeadingComments: true }),
    ).toHaveLength(1);
  });
});

describe("statementAt", () => {
  const sql = "select 1;\n\nselect\n  2;\nselect 3";
  const ranges = splitStatements(sql, null, { blankLines: true });

  it("finds the statement containing the cursor, delimiter included", () => {
    expect(statementAt(ranges, 0)?.text).toBe("select 1");
    expect(statementAt(ranges, 9)?.text).toBe("select 1"); // right after the `;`
    expect(statementAt(ranges, sql.indexOf("  2"))?.text).toBe("select\n  2");
    expect(statementAt(ranges, sql.length)?.text).toBe("select 3");
  });

  it("belongs to none on a blank line between statements", () => {
    expect(statementAt(ranges, 10)).toBeNull();
  });
});

describe("unicode", () => {
  it("handles non-ASCII identifiers and astral characters in strings", () => {
    const sql = "select 'café 😀; ok', 名前 from t; select 2";
    expect(splitStatements(sql, null).map((s) => s.text)).toEqual([
      "select 'café 😀; ok', 名前 from t",
      "select 2",
    ]);
  });
});
