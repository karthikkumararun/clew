import { describe, expect, it } from "vitest";
import type { Value } from "../../../lib/ipc/drivers";
import { buildCopy, readPaste, toInput } from "./clipboard";
import { plan } from "./plan";
import type { PasteColumn } from "./plan";

const t = (s: string): Value => ({ kind: "text", value: s });
const dec = (s: string): Value => ({ kind: "decimal", value: s });
const NULL: Value = { kind: "null" };
const cols: PasteColumn[] = [
  { name: "status", kind: "text", nullable: true, editable: true },
  { name: "total", kind: "decimal", nullable: true, editable: true },
];

describe("typed clipboard", () => {
  const rows: Value[][] = [
    [t(""), dec("1150.00")],
    [NULL, dec("0.10")],
    [t('multi\nline\t"q"'), NULL],
  ];

  it("copies TSV with Excel quoting and NULL as empty", () => {
    const { text } = buildCopy(["status", "total"], rows);
    expect(text).toBe('\t1150.00\r\n\t0.10\r\n"multi\nline\t""q"""\t\r\n');
    expect(buildCopy(["a", "b"], [], { headers: true }).text).toBe("a\tb\r\n");
  });

  it("round trips NULL vs '' and exact decimals (spec: data-grid › Copy and paste inside the grid)", () => {
    const { text, typed } = buildCopy(["status", "total"], rows);
    const src = readPaste(text, typed);
    expect(src.kind).toBe("typed");
    const input = toInput(src);
    expect(input.format).toBe("typed");
    const p = plan(input.table, { row: 0, col: 0, rows: 1, cols: 1 }, cols, true, { rowCount: 3 });
    expect(p.assignments.map((a) => a.value)).toEqual([
      t(""),
      dec("1150.00"),
      NULL,
      dec("0.10"),
      t('multi\nline\t"q"'),
      NULL,
    ]);
  });

  it("without the typed payload the same text pastes by text rules", () => {
    const { text } = buildCopy(["status", "total"], rows);
    const src = readPaste(text, null);
    expect(src.kind).toBe("text");
    const input = toInput(src);
    const p = plan(input.table, { row: 0, col: 0, rows: 1, cols: 1 }, cols, true, { rowCount: 3 });
    expect(p.assignments[0].value).toEqual(t(""));
    expect(p.assignments[2].value).toEqual(t(""));
    expect(p.assignments[5].value).toEqual(NULL);
  });

  it("falls back to text for a malformed or mismatched payload", () => {
    const { text, typed } = buildCopy(["status", "total"], rows);
    expect(readPaste(text, "{nope").kind).toBe("text");
    expect(readPaste(text, '{"version":2,"rows":[]}').kind).toBe("text");
    expect(readPaste(text, '{"version":1,"rows":[[1]]}').kind).toBe("text");
    expect(readPaste("other\ttext\n", typed).kind).toBe("text");
  });

  it("a single empty cell survives", () => {
    const { text, typed } = buildCopy(["a"], [[t("")]]);
    expect(readPaste(text, typed).kind).toBe("typed");
  });

  it("forced format ignores the typed payload (Interpret as)", () => {
    const { text, typed } = buildCopy(["status", "total"], rows);
    const input = toInput(readPaste(text, typed), undefined, "single");
    expect(input.format).toBe("single");
  });
});
