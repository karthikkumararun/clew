import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ColumnMeta, Value } from "../../../lib/ipc/drivers";
import { ColumnarStore } from "../../grid/source";
import { col, int, text } from "../../grid/tools/testing";
import { ResultTextView } from "./TextView";
import { ResultTreeView } from "./TreeView";
import { ViewAs } from "./ViewAs";
import type { ViewMode } from "./ViewAs";
import { useExtractorOptions } from "./useExtractorOptions";

const columns: ColumnMeta[] = [
  { ...col("id", "int"), source_column: "id" },
  { ...col("payload", "json"), source_column: "payload" },
  col("with_tax", "decimal"),
];
const json = (value: unknown): Value => ({ kind: "json", value: value as never });
const rows: Value[][] = [
  [int(1), json({ carrier: "UPS", parcels: [1, 2] }), { kind: "decimal", value: "11.00" }],
  [int(2), json({ carrier: "DHL", parcels: [] }), { kind: "decimal", value: "22.00" }],
];

function store() {
  const s = new ColumnarStore(columns);
  s.append(rows);
  return s;
}

function Harness({
  initial = "table",
  transpose = false,
  onCopy,
}: {
  initial?: ViewMode;
  transpose?: boolean;
  onCopy?: (t: string) => void;
}) {
  const [mode, setMode] = useState<ViewMode>(initial);
  const [t, setT] = useState(transpose);
  const extractor = useExtractorOptions("csv");
  const source = store();
  const view = {
    source,
    columns,
    storeRows: [0, 1],
    extractor,
    transpose: t,
  };
  return (
    <div>
      <ViewAs mode={mode} onMode={setMode} transpose={t} onTranspose={setT} extractor={extractor} />
      {mode === "tree" ? <ResultTreeView {...view} /> : null}
      {mode === "text" ? <ResultTextView {...view} onCopy={onCopy} /> : null}
    </div>
  );
}

describe("ViewAs control", () => {
  it("offers Table, Tree and Text as a radiogroup with Transpose (spec: data-grid › View as)", () => {
    render(<Harness />);
    const group = screen.getByRole("radiogroup", { name: "View as" });
    expect(within(group).getAllByRole("radio").map((r) => r.textContent)).toEqual([
      "Table",
      "Tree",
      "Text",
    ]);
    expect(screen.getByRole("radio", { name: "Table" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(screen.getByRole("radio", { name: "Text" })).toBeChecked();
    const transpose = screen.getByRole("button", { name: "Transpose" });
    expect(transpose).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(transpose);
    expect(transpose).toHaveAttribute("aria-pressed", "true");
  });

  it("moves the mode with the arrow keys (spec: data-grid › View as)", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByRole("radio", { name: "Table" }), { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Tree" })).toBeChecked();
  });
});

describe("Tree view", () => {
  it("expands each row's JSON into keys and values (spec: data-grid › JSON in tree view)", () => {
    render(<Harness initial="tree" />);
    const tree = screen.getByRole("table", { name: "Documents" });
    expect(within(tree).getByText("Row 1")).toBeInTheDocument();
    expect(within(tree).getByText("Row 2")).toBeInTheDocument();
    expect(tree).toHaveTextContent("carrier");
    expect(tree).toHaveTextContent('"UPS"');
    expect(tree).toHaveTextContent("parcels");
    expect(tree).toHaveTextContent('"DHL"');
  });

  it("makes one root per column when transposed (spec: data-grid › View as)", () => {
    render(<Harness initial="tree" transpose />);
    const tree = screen.getByRole("table", { name: "Documents" });
    expect(within(tree).getByText("payload")).toBeInTheDocument();
    expect(tree).toHaveTextContent("#1");
    expect(tree).toHaveTextContent("#2");
  });

  it("collapses and expands a node (spec: data-grid › JSON in tree view)", () => {
    render(<Harness initial="tree" />);
    fireEvent.click(screen.getAllByRole("button", { name: "Collapse Row 1" })[0]);
    expect(screen.queryByText('"UPS"')).not.toBeInTheDocument();
  });
});

describe("Text view", () => {
  it("shows CSV with a header and Copy copies it (spec: data-grid › Text view as CSV)", async () => {
    const onCopy = vi.fn();
    render(<Harness initial="text" onCopy={onCopy} />);
    const box = screen.getByRole("textbox", { name: "Result text" });
    expect(box).toHaveAttribute("aria-readonly", "true");
    expect(box.textContent?.split(/\r?\n/)[0]).toBe("id,payload,with_tax");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(onCopy).toHaveBeenCalledTimes(1));
    expect(onCopy.mock.calls[0][0]).toBe(box.textContent);
    expect(await screen.findByRole("status")).toHaveTextContent("Copied");
  });

  it("switches format from the Format select (spec: data-grid › Text view as CSV)", () => {
    render(<Harness initial="text" />);
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "markdown" } });
    expect(screen.getByRole("textbox", { name: "Result text" }).textContent).toMatch(
      /^\| id \| payload \| with_tax \|/,
    );
  });
});

describe("Extractor options dialog", () => {
  it("skips computed columns and remembers options per format (spec: data-grid › Skip computed columns)", () => {
    render(<Harness initial="text" />);
    fireEvent.click(screen.getByRole("button", { name: "Extractor options" }));
    const dialog = screen.getByRole("dialog", { name: "Extractor options" });
    fireEvent.change(within(dialog).getByLabelText("Format"), { target: { value: "insert" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Skip computed columns/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    const out = screen.getByRole("textbox", { name: "Result text" }).textContent ?? "";
    expect(out).toMatch(/INSERT INTO/);
    expect(out).not.toContain("with_tax");

    // CSV keeps its own options: with_tax is still there.
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "csv" } });
    expect(screen.getByRole("textbox", { name: "Result text" }).textContent).toContain("with_tax");
    fireEvent.change(screen.getByLabelText("Format"), { target: { value: "insert" } });
    expect(screen.getByRole("textbox", { name: "Result text" }).textContent).not.toContain(
      "with_tax",
    );
  });

  it("offers header, delimiter, quote, NULL text and the generated toggle (spec: data-grid › Extractor options)", () => {
    render(<Harness initial="text" />);
    fireEvent.click(screen.getByRole("button", { name: "Extractor options" }));
    const dialog = screen.getByRole("dialog");
    for (const name of ["Format", "Delimiter", "Quote", "NULL text", "Date format"]) {
      expect(within(dialog).getByLabelText(name)).toBeInTheDocument();
    }
    expect(within(dialog).getByRole("checkbox", { name: "Header row" })).toBeChecked();
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "Header row" }));
    fireEvent.change(within(dialog).getByLabelText("Delimiter"), { target: { value: ";" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: /Skip generated columns/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Apply" }));
    expect(screen.getByRole("textbox", { name: "Result text" }).textContent?.split(/\r?\n/)[0]).toBe(
      '1;"{""carrier"":""UPS"",""parcels"":[1,2]}";11.00',
    );
  });
});

void text;
