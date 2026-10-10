import { describe, expect, it } from "vitest";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import { lookOf, oneLine } from "./cellStyle";
import { format, toInserts, toMarkdown } from "./copyFormats";
import { selectedCells } from "./selection";
import { ColumnarStore, RowsSource, sourceOf } from "./source";
import { flavorOf, quoteIdent, sqlLiteral } from "./sqlLiteral";
import { gridTheme, token } from "./theme";
import { SortedSource, TransposedSource, moveColumn, nextSort, visibleColumns } from "./views";
import { CompactSelection } from "@glideapps/glide-data-grid";

const col = (name: string, type_name = "text", kind: ColumnMeta["kind"] = "text"): ColumnMeta => ({
  name,
  type_name,
  kind,
  nullable: true,
});
const int = (n: number): Value => ({ kind: "int", value: n });
const text = (s: string): Value => ({ kind: "text", value: s });
const NULL: Value = { kind: "null" };

describe("ColumnarStore", () => {
  const columns = [col("id", "int8", "int"), col("name")];

  it("looks up cells in O(1) across batches", () => {
    const s = new ColumnarStore(columns);
    s.append([
      [int(1), text("a")],
      [int(2), text("b")],
    ]);
    s.append([[int(3), text("c")]]);
    s.append([
      [int(4), NULL],
      [int(5), text("e")],
    ]);
    expect(s.rowCount).toBe(5);
    expect(s.get(0, 0)).toEqual(int(1));
    expect(s.get(1, 2)).toEqual(text("c"));
    expect(s.get(1, 3)).toEqual(NULL);
    expect(s.get(0, 4)).toEqual(int(5));
    // random access, backwards, and out of range
    expect(s.get(1, 1)).toEqual(text("b"));
    expect(s.get(0, 0)).toEqual(int(1));
    expect(s.get(0, 99)).toEqual(NULL);
    expect(s.row(2)).toEqual([int(3), text("c")]);
  });

  it("bumps its version on every change so views repaint", () => {
    const s = new ColumnarStore(columns);
    const v0 = s.version;
    s.append([[int(1), text("a")]]);
    expect(s.version).toBeGreaterThan(v0);
    const v1 = s.version;
    s.append([]);
    expect(s.version).toBe(v1);
    s.set(1, 0, text("z"));
    expect(s.get(1, 0)).toEqual(text("z"));
    expect(s.version).toBeGreaterThan(v1);
  });

  it("replaces a page and resets for a new query", () => {
    const s = new ColumnarStore(columns);
    s.append([
      [int(1), text("a")],
      [int(2), text("b")],
    ]);
    s.replace([[int(9), text("z")]]);
    expect(s.rowCount).toBe(1);
    expect(s.get(0, 0)).toEqual(int(9));
    s.reset([col("only")]);
    expect(s.rowCount).toBe(0);
    expect(s.columns.map((c) => c.name)).toEqual(["only"]);
  });

  it("stays fast with a million rows", () => {
    const s = new ColumnarStore([col("n", "int8", "int")]);
    const page = Array.from({ length: 1000 }, (_, i) => [int(i)]);
    for (let i = 0; i < 1000; i++) s.append(page);
    expect(s.rowCount).toBe(1_000_000);
    const start = performance.now();
    let sum = 0;
    for (let r = 0; r < 1_000_000; r += 7) sum += (s.get(0, r) as { value: number }).value;
    expect(sum).toBeGreaterThan(0);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("RowsSource", () => {
  it("reads a row-major result that keeps growing", () => {
    const rows: Value[][] = [[int(1)]];
    const src = new RowsSource([col("n", "int8", "int")], rows);
    expect(src.rowCount).toBe(1);
    rows.push([int(2)]);
    expect(src.rowCount).toBe(2);
    expect(src.get(0, 1)).toEqual(int(2));
    expect(src.get(0, 5)).toEqual(NULL);
  });
});

describe("cell looks", () => {
  it("colours and aligns by value kind", () => {
    expect(lookOf(int(5))).toMatchObject({ token: "syn-number", align: "right", italic: false });
    expect(lookOf({ kind: "decimal", value: "12.50" })).toMatchObject({
      token: "syn-number",
      align: "right",
    });
    expect(lookOf({ kind: "timestamptz", value: "2026-10-08 21:14:07+00" })).toMatchObject({
      token: "syn-date",
      align: "left",
    });
    expect(lookOf({ kind: "bool", value: true })).toMatchObject({
      token: "syn-boolean",
      text: "true",
    });
    expect(lookOf(text("hello"))).toMatchObject({ token: "text", align: "left" });
    expect(lookOf({ kind: "uuid", value: "0e0e0e0e-0e0e-0e0e-0e0e-0e0e0e0e0e0e" }).token).toBe(
      "text",
    );
  });

  it("draws NULL as italic NULL that copies as an empty field", () => {
    expect(lookOf(NULL)).toMatchObject({ text: "NULL", copy: "", token: "syn-null", italic: true });
  });

  it("links foreign keys", () => {
    expect(lookOf(int(1042), { foreignKey: true })).toMatchObject({
      token: "syn-link",
      underline: true,
      align: "right",
    });
    expect(lookOf(NULL, { foreignKey: true }).underline).toBe(false);
  });

  it("marks truncated values with an ellipsis", () => {
    const look = lookOf({ kind: "text", value: "start of a very long", truncated: true });
    expect(look).toMatchObject({
      text: "start of a very long…",
      truncated: true,
      copy: "start of a very long",
    });
    expect(lookOf({ kind: "bytes", value: "ab", len: 4096, truncated: true }).truncated).toBe(true);
  });

  it("keeps multi-line text on one row", () => {
    expect(oneLine("a\nb\r\n  c")).toBe("a ↵ b ↵ c");
    expect(lookOf(text("line one\nline two")).text).toBe("line one ↵ line two");
  });
});

describe("theme", () => {
  it("reads colours from the design tokens", () => {
    const root = document.createElement("div");
    root.style.setProperty("--text", "rgb(1, 2, 3)");
    root.style.setProperty("--accent", "rgb(4, 5, 6)");
    document.body.append(root);
    expect(token("text", root)).toBe("rgb(1, 2, 3)");
    const theme = gridTheme(root);
    expect(theme.textDark).toBe("rgb(1, 2, 3)");
    expect(theme.accentColor).toBe("rgb(4, 5, 6)");
    expect(token("not-a-token", root)).toBe("CanvasText");
    root.remove();
  });
});

describe("selection", () => {
  const sel = (over: object) => ({
    columns: CompactSelection.empty(),
    rows: CompactSelection.empty(),
    ...over,
  });

  it("covers a rectangle, clipped to the data", () => {
    const s = sel({
      current: {
        cell: [1, 2],
        range: { x: 1, y: 2, width: 3, height: 10 },
        rangeStack: [],
      },
    });
    expect(selectedCells(s as never, 5, 6)).toEqual({ cols: [1, 2, 3], rows: [2, 3, 4] });
  });

  it("covers whole rows or whole columns", () => {
    expect(
      selectedCells(sel({ rows: CompactSelection.fromSingleSelection([1, 3]) }) as never, 10, 3),
    ).toEqual({
      rows: [1, 2],
      cols: [0, 1, 2],
    });
    expect(
      selectedCells(sel({ columns: CompactSelection.fromSingleSelection(2) }) as never, 3, 4),
    ).toEqual({
      rows: [0, 1, 2],
      cols: [2],
    });
    expect(selectedCells(sel({}) as never, 3, 4)).toEqual({ rows: [], cols: [] });
  });
});

describe("sort, columns and transpose", () => {
  const columns = [col("n", "int8", "int"), col("s")];
  const rows: Value[][] = [
    [int(10), text("b")],
    [NULL, text("c")],
    [int(2), text("a")],
    [int(10), text("a")],
  ];

  it("cycles ascending, descending, none", () => {
    let s = nextSort(null, 1);
    expect(s).toEqual({ column: 1, dir: "asc" });
    s = nextSort(s, 1);
    expect(s).toEqual({ column: 1, dir: "desc" });
    expect(nextSort(s, 1)).toBeNull();
    expect(nextSort({ column: 1, dir: "desc" }, 0)).toEqual({ column: 0, dir: "asc" });
  });

  it("sorts numbers numerically, text lexically, NULLs last, stably", () => {
    const base = sourceOf(columns, rows);
    const asc = new SortedSource(base, { column: 0, dir: "asc" });
    expect([0, 1, 2, 3].map((r) => asc.get(1, r))).toEqual([
      text("a"),
      text("b"),
      text("a"),
      text("c"),
    ]);
    expect(asc.get(0, 3)).toEqual(NULL);
    const desc = new SortedSource(base, { column: 0, dir: "desc" });
    expect([0, 1, 2].map((r) => desc.get(0, r))).toEqual([int(10), int(10), int(2)]);
    expect(desc.get(0, 3)).toEqual(NULL);
    const text1 = new SortedSource(base, { column: 1, dir: "asc" });
    expect([0, 1, 2, 3].map((r) => (text1.get(1, r) as { value: string }).value)).toEqual([
      "a",
      "a",
      "b",
      "c",
    ]);
    expect(text1.sourceRow(0)).toBe(2);
  });

  it("compares huge integers exactly", () => {
    const big = sourceOf(
      [col("n", "int8", "bigint")],
      [
        [{ kind: "bigint", value: "9007199254740993" }],
        [{ kind: "bigint", value: "9007199254740992" }],
      ],
    );
    const s = new SortedSource(big, { column: 0, dir: "asc" });
    expect(s.get(0, 0)).toEqual({ kind: "bigint", value: "9007199254740992" });
  });

  it("transposes one row into column name and value", () => {
    const t = new TransposedSource(sourceOf(columns, [rows[0]]));
    expect(t.columns.map((c) => c.name)).toEqual(["column", "value"]);
    expect(t.rowCount).toBe(2);
    expect(t.get(0, 1)).toEqual(text("s"));
    expect(t.get(1, 0)).toEqual(int(10));
  });

  it("transposes several rows into numbered columns", () => {
    const t = new TransposedSource(sourceOf(columns, rows));
    expect(t.columns.map((c) => c.name)).toEqual(["column", "#1", "#2", "#3", "#4"]);
    expect(t.get(2, 1)).toEqual(text("c"));
  });

  it("keeps hidden columns out and applies a saved order", () => {
    expect(visibleColumns(4, [2, 0], new Set([1]))).toEqual([2, 0, 3]);
    expect(visibleColumns(3, [9, 1, 1], new Set())).toEqual([1, 0, 2]);
    expect(moveColumn([0, 1, 2, 3], 3, 1)).toEqual([0, 3, 1, 2]);
  });
});

describe("SQL literals and copy formats", () => {
  const cols = ["id", "note", "ok", "at", "blob"];
  const rows: Value[][] = [
    [
      int(1),
      text("it's"),
      { kind: "bool", value: true },
      { kind: "timestamp", value: "2026-10-08 09:00:00" },
      { kind: "bytes", value: "00ff", len: 2 },
    ],
    [int(2), NULL, { kind: "bool", value: false }, NULL, NULL],
  ];

  it("quotes identifiers and literals per dialect", () => {
    expect(quoteIdent("postgres", 'we"ird')).toBe('"we""ird"');
    expect(quoteIdent("mysql", "we`ird")).toBe("`we``ird`");
    expect(quoteIdent("sqlserver", "we]ird")).toBe("[we]]ird]");
    expect(sqlLiteral("postgres", text("it's"))).toBe("'it''s'");
    expect(sqlLiteral("mysql", text("a\\b'c"))).toBe("'a\\\\b''c'");
    expect(sqlLiteral("postgres", { kind: "bool", value: true })).toBe("TRUE");
    expect(sqlLiteral("sqlite", { kind: "bool", value: true })).toBe("1");
    expect(sqlLiteral("postgres", { kind: "bytes", value: "00ff", len: 2 })).toBe("'\\x00ff'");
    expect(sqlLiteral("mysql", { kind: "bytes", value: "00ff", len: 2 })).toBe("X'00ff'");
    expect(sqlLiteral("sqlserver", { kind: "bytes", value: "00ff", len: 2 })).toBe("0x00ff");
    expect(sqlLiteral("postgres", { kind: "decimal", value: "12.50" })).toBe("12.50");
    expect(sqlLiteral("postgres", { kind: "decimal", value: "NaN" })).toBe("'NaN'");
    expect(sqlLiteral("postgres", { kind: "json", value: { a: [1, "x'y"] } })).toBe(
      `'{"a":[1,"x''y"]}'`,
    );
    expect(flavorOf("mariadb")).toBe("mysql");
    expect(flavorOf("duckdb")).toBe("postgres");
  });

  it("copies a range as TSV with NULL as an empty field", () => {
    const tsv = format({ columns: cols.slice(0, 2), rows: rows.map((r) => r.slice(0, 2)) }, "tsv", {
      flavor: "postgres",
      table: '"orders"',
      headers: false,
    });
    expect(tsv).toBe("1\tit's\n2\t\n");
  });

  it("copies as CSV, JSON and Markdown", () => {
    const data = {
      columns: ["id", "note"],
      rows: [
        [int(1), text('say "hi" | ok')],
        [int(2), NULL],
      ],
    };
    const o = { flavor: "postgres" as const, table: '"t"' };
    expect(format(data, "csv", o)).toBe('id,note\r\n1,"say ""hi"" | ok"\r\n2,\r\n');
    expect(JSON.parse(format(data, "json", o))).toEqual([
      { id: 1, note: 'say "hi" | ok' },
      { id: 2, note: null },
    ]);
    expect(toMarkdown(data.columns, data.rows)).toBe(
      '| id | note |\n| --- | --- |\n| 1 | say "hi" \\| ok |\n| 2 | NULL |\n',
    );
  });

  it("copies as INSERT with dialect quoting", () => {
    expect(toInserts("postgres", '"public"."orders"', cols, rows)).toBe(
      `INSERT INTO "public"."orders" ("id", "note", "ok", "at", "blob") VALUES (1, 'it''s', TRUE, '2026-10-08 09:00:00', '\\x00ff');\n` +
        `INSERT INTO "public"."orders" ("id", "note", "ok", "at", "blob") VALUES (2, NULL, FALSE, NULL, NULL);\n`,
    );
    expect(
      toInserts(
        "mysql",
        "`orders`",
        ["id", "note"],
        rows.map((r) => r.slice(0, 2)),
      ),
    ).toBe(
      "INSERT INTO `orders` (`id`, `note`) VALUES (1, 'it''s');\nINSERT INTO `orders` (`id`, `note`) VALUES (2, NULL);\n",
    );
    expect(toInserts("sqlserver", "[orders]", ["ok"], [[{ kind: "bool", value: true }]])).toBe(
      "INSERT INTO [orders] ([ok]) VALUES (1);\n",
    );
  });
});
