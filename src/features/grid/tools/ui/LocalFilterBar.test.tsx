import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { filterRows } from "../localFilter";
import type { ColumnFilter } from "../localFilter";
import { ColumnarStore } from "../../source";
import { col, dec, text } from "../testing";
import { LocalFilterBar } from "./LocalFilterBar";

const columns = [col("status"), col("total", "decimal", "numeric(10,2)")];
const store = new ColumnarStore(columns);
store.append([
  [text("shipped"), dec("250.00")],
  [text("shipped"), dec("100.00")],
  [text("new"), dec("300.00")],
]);

function Harness({ hidden = 0 }: { hidden?: number }) {
  const [filters, setFilters] = useState<ColumnFilter[]>([]);
  const shown = filterRows(store, filters).length;
  return (
    <LocalFilterBar
      columns={columns}
      filters={filters}
      onChange={setFilters}
      summary={{ shown, total: store.rowCount }}
      hiddenPending={hidden}
    />
  );
}

describe("LocalFilterBar", () => {
  it("applies two filters and shows the count (spec: data-grid › Two filters)", () => {
    render(<Harness />);
    fireEvent.change(screen.getByRole("textbox", { name: "Filter status" }), {
      target: { value: "contains ship" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter total" }), {
      target: { value: "> 200" },
    });
    expect(screen.getByRole("status", { name: "Filter summary" })).toHaveTextContent(
      "Showing 1 of 3 rows",
    );
  });

  it("shows all rows again when cleared (spec: data-grid › Clear)", () => {
    render(<Harness />);
    const status = screen.getByRole("textbox", { name: "Filter status" });
    fireEvent.change(status, { target: { value: "ship" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Filter total" }), {
      target: { value: "> 200" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Clear filter on status" }));
    expect(screen.getByRole("status", { name: "Filter summary" })).toHaveTextContent(
      "Showing 2 of 3 rows",
    );
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(screen.getByRole("status", { name: "Filter summary" })).toHaveTextContent(
      "Showing 3 of 3 rows",
    );
    expect(status).toHaveValue("");
  });

  it("shows an error for input that does not parse and keeps the old filter", () => {
    render(<Harness />);
    const total = screen.getByRole("textbox", { name: "Filter total" });
    fireEvent.change(total, { target: { value: "> abc" } });
    expect(screen.getByText("'abc' is not a number")).toBeInTheDocument();
    expect(total).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("status", { name: "Filter summary" })).toHaveTextContent(
      "Showing 3 of 3 rows",
    );
  });

  it("notes pending changes in hidden rows (spec: data-grid › Two filters)", () => {
    render(<Harness hidden={1} />);
    expect(screen.getByText("1 pending change is in a hidden row")).toBeInTheDocument();
  });
});
