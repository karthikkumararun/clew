/** Contract: View as Tree / Text, Transpose and extractor option tests. */
import { describe, expect, it } from "vitest";
import type { Value } from "../../../lib/ipc/drivers";
import { toCsv } from "../../console/valueFormat";
import { describe as describeEJson } from "../../documents/ejson";
import { flattenDocs } from "../../documents/treeModel";
import { format } from "../copyFormats";
import { NULL, col, dec, int, text } from "./testing";
import {
  applyExtractorOptions,
  defaultExtractorOptions,
  defaultExtractorStore,
  formatExtract,
  optionsFor,
  pickData,
  rememberOptions,
  toText,
  toTree,
  transposeData,
} from "./viewAs";
import type { ExtractorColumn } from "./viewAs";
import { sourceOf } from "../source";

const columns: ExtractorColumn[] = [
  { ...col("id", "int"), source_column: "id" },
  { ...col("status"), source_column: "status" },
  { ...col("total", "decimal"), source_column: "total" },
  { ...col("with_tax", "decimal") }, // an expression: no source column
  { ...col("seq", "int"), source_column: "seq", generated: true },
];
const rows: Value[][] = [
  [int(1), text("shipped"), dec("10.00"), dec("12.00"), int(100)],
  [int(2), NULL, dec("5.50"), dec("6.60"), int(101)],
];

describe("extractor options", () => {
  it("leaves computed columns out of SQL INSERT (spec: data-grid › Skip computed columns)", () => {
    const o = {
      ...defaultExtractorOptions("insert"),
      table: '"orders"',
      flavor: "postgres" as const,
      skipComputed: true,
    };
    const out = formatExtract({ columns, rows }, o);
    expect(out).toBe(
      `INSERT INTO "orders" ("id", "status", "total", "seq") VALUES (1, 'shipped', 10.00, 100);\n` +
        `INSERT INTO "orders" ("id", "status", "total", "seq") VALUES (2, NULL, 5.50, 101);\n`,
    );
    expect(out).not.toContain("with_tax");
  });

  it("skips generated columns independently of computed ones", () => {
    const x = applyExtractorOptions(
      { columns, rows },
      { ...defaultExtractorOptions("csv"), skipGenerated: true },
    );
    expect(x.names).toEqual(["id", "status", "total", "with_tax"]);
    expect(x.kept).toEqual([0, 1, 2, 3]);
    const both = applyExtractorOptions(
      { columns, rows },
      { ...defaultExtractorOptions("csv"), skipGenerated: true, skipComputed: true },
    );
    expect(both.names).toEqual(["id", "status", "total"]);
    expect(both.rows[1]).toEqual([int(2), NULL, dec("5.50")]);
    // an explicit flag wins over inference
    const flagged = [{ ...columns[3], computed: false }];
    expect(
      applyExtractorOptions(
        { columns: flagged, rows: [[dec("1")]] },
        { ...defaultExtractorOptions("csv"), skipComputed: true },
      ).names,
    ).toEqual(["with_tax"]);
  });

  it("does not guess computed columns when no provenance exists", () => {
    const plain = [col("a"), col("b")];
    expect(
      applyExtractorOptions(
        { columns: plain, rows: [] },
        { ...defaultExtractorOptions("csv"), skipComputed: true },
      ).names,
    ).toEqual(["a", "b"]);
  });

  it("remembers options per format", () => {
    let store = defaultExtractorStore();
    store = rememberOptions(store, { ...optionsFor(store, "csv"), delimiter: ";" });
    expect(optionsFor(store, "csv").delimiter).toBe(";");
    expect(optionsFor(store, "tsv").delimiter).toBe("\t");
    expect(optionsFor(store, "markdown").nullText).toBe("NULL");
  });

  it("applies the date format to date columns", () => {
    const cols = [col("at", "timestamp")];
    const data = {
      columns: cols,
      rows: [[{ kind: "timestamp", value: "2024-01-05 10:30:00" } as Value]],
    };
    const out = formatExtract(data, { ...defaultExtractorOptions("csv"), dateFormat: "us" });
    expect(out).toBe("at\r\n01/05/2024 10:30:00\r\n");
  });
});

describe("Text view", () => {
  it("shows rows as CSV text with a header (spec: data-grid › Text view as CSV)", () => {
    const o = defaultExtractorOptions("csv");
    const out = toText(rows, columns, { extractor: o });
    expect(out).toBe(
      toCsv(
        columns.map((c) => c.name),
        rows,
      ),
    ); // same text as Copy as / export
    expect(out.split("\r\n")[0]).toBe("id,status,total,with_tax,seq");
  });

  it("matches the copy formatters for tsv, markdown and json", () => {
    const names = columns.map((c) => c.name);
    const base = { flavor: "standard" as const, table: "t" };
    for (const [fmt, as] of [
      ["tsv", "tsv"],
      ["markdown", "markdown"],
      ["json", "json"],
    ] as const) {
      const o = { ...defaultExtractorOptions(fmt), nullText: fmt === "markdown" ? "NULL" : "" };
      expect(toText(rows, columns, { extractor: o })).toBe(
        format({ columns: names, rows }, as, base),
      );
    }
  });

  it("writes JSON lines, custom delimiters, quoting and NULL text", () => {
    const jl = toText(rows, columns, { extractor: defaultExtractorOptions("jsonl") });
    expect(
      jl
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).id),
    ).toEqual([1, 2]);
    const o = {
      ...defaultExtractorOptions("csv"),
      delimiter: ";",
      nullText: "\\N",
      quote: "always" as const,
      header: false,
    };
    expect(toText(rows, columns.slice(0, 3), { extractor: o })).toBe(
      '"1";"shipped";"10.00"\r\n"2";"\\N";"5.50"\r\n',
    );
    const tsv = toText(rows, columns.slice(0, 2), {
      extractor: { ...defaultExtractorOptions("tsv"), header: false },
    });
    expect(tsv).toBe("1\tshipped\n2\t\n");
  });

  it("transposes one row into column / value lines", () => {
    const t = transposeData({ columns, rows: [rows[0]] });
    expect(t.columns.map((c) => c.name)).toEqual(["column", "value"]);
    expect(t.rows).toHaveLength(5);
    const out = toText([rows[0]], columns, {
      extractor: defaultExtractorOptions("csv"),
      transpose: true,
    });
    expect(out).toBe(
      "column,value\r\nid,1\r\nstatus,shipped\r\ntotal,10.00\r\nwith_tax,12.00\r\nseq,100\r\n",
    );
  });

  it("transposes a selection into #1, #2 columns and honours skip flags and the limit", () => {
    const o = { ...defaultExtractorOptions("csv"), skipComputed: true, skipGenerated: true };
    const out = toText(rows, columns, { extractor: o, transpose: true });
    expect(out).toBe("column,#1,#2\r\nid,1,2\r\nstatus,shipped,\r\ntotal,10.00,5.50\r\n");
    const limited = toText(rows, columns, {
      extractor: defaultExtractorOptions("csv"),
      transpose: true,
      transposeLimit: 1,
    });
    expect(limited.split("\r\n")[0]).toBe("column,value");
  });

  it("picks the selection's cells from a source", () => {
    const s = sourceOf(columns, rows);
    expect(pickData(s, columns, [1], [0, 2]).rows).toEqual([[int(2), dec("5.50")]]);
  });
});

describe("Tree view", () => {
  const tcols = [
    col("id", "int"),
    col("doc", "json", "jsonb"),
    col("tags", "array"),
    col("at", "timestamptz"),
    col("uid", "uuid"),
  ];
  const trows: Value[][] = [
    [
      int(1),
      { kind: "json", value: { name: "Ada", address: { city: "London" }, n: [1, 2] } },
      { kind: "array", value: [text("a"), text("b")] },
      { kind: "timestamptz", value: "2024-01-05 10:00:00+00" },
      { kind: "uuid", value: "123e4567-e89b-12d3-a456-426614174000" },
    ],
  ];

  it("expands JSON into keys and values in place (spec: data-grid › JSON in tree view)", () => {
    const tree = toTree(trows, tcols);
    expect(tree.titles).toEqual(["Row 1"]);
    const doc = tree.docs[0];
    const open = new Set<string>();
    const key = tree.keyOf(doc);
    open.add(`${key}|[]`);
    open.add(`${key}|["doc"]`);
    open.add(`${key}|["doc","address"]`);
    const flat = flattenDocs(tree.docs, open, tree.keyOf);
    const labels = flat.map((r) => `${"  ".repeat(r.depth)}${r.label}`);
    expect(labels).toContain("  doc");
    expect(labels).toContain("    name");
    expect(labels).toContain("      city");
    const byLabel = (l: string) => flat.find((r) => r.label === l)!;
    expect(byLabel("name").described).toMatchObject({ type: "String", text: "Ada" });
    expect(byLabel("city").described.text).toBe("London");
    expect(byLabel("id").described.type).toBe("Int32");
    expect(byLabel("at").described.type).toBe("Date");
    expect(byLabel("uid").described).toMatchObject({
      type: "UUID",
      text: "123e4567-e89b-12d3-a456-426614174000",
    });
    expect(byLabel("tags").described.type).toBe("Array");
  });

  it("transposes to one root per column with an entry per row", () => {
    const two = [...trows, trows[0]];
    const t = toTree(two, tcols, { transpose: true });
    expect(t.titles).toEqual(["id", "doc", "tags", "at", "uid"]);
    expect(Object.keys(t.docs[0] as object)).toEqual(["#1", "#2"]);
    const single = toTree(trows, tcols, { transpose: true });
    expect(Object.keys(single.docs[1] as object)).toEqual(["value"]);
    expect(describeEJson((single.docs[0] as Record<string, never>).value).type).toBe("Int32");
  });

  it("disambiguates duplicate column names and skips flagged columns", () => {
    const dup = toTree([[int(1), int(2)]], [col("a", "int"), col("a", "int")]);
    expect(Object.keys(dup.docs[0] as object)).toEqual(["a", "a (2)"]);
    const skipped = toTree(rows, columns, {
      extractor: { ...defaultExtractorOptions("csv"), skipComputed: true },
    });
    expect(Object.keys(skipped.docs[0] as object)).toEqual(["id", "status", "total", "seq"]);
  });
});
