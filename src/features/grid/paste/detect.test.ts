import { describe, expect, it } from "vitest";
import { detect, interpretAs, parseDelimited } from "./detect";

const COLS = ["id", "status", "total"];

describe("detect: real-world samples", () => {
  it("Excel TSV with a quoted multi-line cell and CRLF (spec: data-grid › Copy and paste inside the grid)", () => {
    const text = 'id\tnote\r\n1\t"line one\r\nline ""two"""\r\n2\tplain\r\n';
    const d = detect(text);
    expect(d.format).toBe("tsv");
    expect(d.table).toEqual([
      ["id", "note"],
      ["1", 'line one\r\nline "two"'],
      ["2", "plain"],
    ]);
    expect(d.hasHeader).toBe(true);
  });

  it("Google Sheets TSV, LF, no trailing newline (spec: data-grid › One value over a selection)", () => {
    const d = detect("shipped\t10.50\nopen\t3");
    expect(d.format).toBe("tsv");
    expect(d.table).toEqual([
      ["shipped", "10.50"],
      ["open", "3"],
    ]);
    expect(d.hasHeader).toBe(false);
  });

  it("comma CSV with a header, quotes and a BOM (spec: data-grid › CSV with header)", () => {
    const text = '﻿id,status,total\n1,"a, b",10\n2,"say ""hi""",20\n';
    const d = detect(text, COLS);
    expect(d.format).toBe("csv");
    expect(d.delimiter).toBe(",");
    expect(d.hasHeader).toBe(true);
    expect(d.table[0][0]).toBe("id");
    expect(d.table[1]).toEqual(["1", "a, b", "10"]);
    expect(d.table[2]).toEqual(["2", 'say "hi"', "20"]);
  });

  it("semicolon CSV with decimal commas (spec: data-grid › Wrong detection)", () => {
    const d = detect("name;price\nbolt;1,5\nnut;2,25\n");
    expect(d.format).toBe("semicolon");
    expect(d.table).toEqual([
      ["name", "price"],
      ["bolt", "1,5"],
      ["nut", "2,25"],
    ]);
    expect(d.hasHeader).toBe(true);
    expect(interpretAs("name;price\nbolt;1,5\n", "csv").table[1]).toEqual(["bolt;1", "5"]);
    expect(interpretAs("a;b\n1;2", "semicolon").table).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("pipe CSV", () => {
    const d = detect("a|b|c\n1|2|3\n4|5|6");
    expect(d.format).toBe("pipe");
  });

  it("Markdown table with escaped pipes and <br> (spec: data-grid › CSV with header)", () => {
    const md = "| id | status |\n| --- | :---: |\n| 1 | a \\| b |\n| 2 | x<br>y |\n";
    const d = detect(md);
    expect(d.format).toBe("markdown");
    expect(d.hasHeader).toBe(true);
    expect(d.table).toEqual([
      ["id", "status"],
      ["1", "a | b"],
      ["2", "x\ny"],
    ]);
    expect(detect("id | status\n--- | ---\n1 | a").table).toEqual([
      ["id", "status"],
      ["1", "a"],
    ]);
  });

  it("JSON array of objects (spec: data-grid › JSON array)", () => {
    const d = detect('[{"status":"shipped","total":10},{"status":"open","note":null}]');
    expect(d.format).toBe("json");
    expect(d.hasHeader).toBe(true);
    expect(d.table).toEqual([
      ["status", "total", "note"],
      ["shipped", "10", "NULL"],
      ["open", "NULL", "NULL"],
    ]);
  });

  it("JSON array of arrays and of scalars (spec: data-grid › JSON array)", () => {
    expect(detect("[[1,2],[3,4]]").table).toEqual([
      ["1", "2"],
      ["3", "4"],
    ]);
    expect(detect("[1,2,3]").table).toEqual([["1"], ["2"], ["3"]]);
  });

  it("invalid JSON falls through to delimiters; forced JSON reports an error", () => {
    expect(detect("[1, 2").format).not.toBe("json");
    expect(interpretAs("nope", "json").error).toBeTruthy();
  });

  it("single column and single value", () => {
    const d = detect("alpha\nbeta\ngamma\n");
    expect(d.table).toEqual([["alpha"], ["beta"], ["gamma"]]);
    expect(detect("Smith, John").table).toEqual([["Smith, John"]]);
    expect(interpretAs("a\tb\n", "single").table).toEqual([["a\tb"]]);
  });

  it("ragged rows keep their lengths", () => {
    const d = detect("a,b,c\n1,2\n3,4,5\n6,7,8\n");
    expect(d.format).toBe("csv");
    expect(d.table.map((r) => r.length)).toEqual([3, 2, 3, 3]);
  });

  it("header by matching grid names or by non-numeric names over numeric data", () => {
    expect(detect("Status,ID\nx,1\n", COLS).hasHeader).toBe(true);
    expect(detect("x,y\n1,2\n").hasHeader).toBe(true);
    expect(detect("1,2\n3,4\n").hasHeader).toBe(false);
    expect(detect("a,b\nc,d\n").hasHeader).toBe(false);
  });

  it("parseDelimited edge cases", () => {
    expect(parseDelimited("", ",")).toEqual([]);
    expect(parseDelimited('"",x', ",")).toEqual([["", "x"]]);
    expect(parseDelimited("a,\n", ",")).toEqual([["a", ""]]);
    expect(parseDelimited('a"b,c', ",")).toEqual([['a"b', "c"]]);
    expect(parseDelimited("a\rb", ",")).toEqual([["a"], ["b"]]);
  });
});
