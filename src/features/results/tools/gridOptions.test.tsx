import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { Value } from "../../../lib/ipc/drivers";
import { GoToRowDialog } from "./GoToRowDialog";
import { GridOptionsMenu } from "./GridOptionsMenu";
import type { GridOptionsMenuProps } from "./GridOptionsMenu";

const row: Record<string, Value> = {
  id: { kind: "int", value: 7 },
  user_id: { kind: "int", value: 42 },
};

function mount(over: Partial<GridOptionsMenuProps> = {}) {
  const props: GridOptionsMenuProps = {
    flavor: "postgres",
    onResetView: vi.fn(),
    query: "SELECT * FROM orders WHERE status = 'new' ORDER BY id LIMIT 100",
    onCopyQueryToConsole: vi.fn(),
    onCopyQueryToClipboard: vi.fn(),
    goTo: { rowCount: 300, keyColumns: 1, keyNames: ["id"], onGo: vi.fn() },
    related: {
      foreignKeys: [
        { columns: ["user_id"], refSchema: "public", refTable: "users", refColumns: ["id"] },
      ],
      referencedBy: [
        { schema: "public", table: "order_items", columns: ["order_id"], refColumns: ["id"] },
      ],
      rowValue: (c) => row[c],
      onOpenRelated: vi.fn(),
    },
    onShowDdl: vi.fn(),
    onRevealInExplorer: vi.fn(),
    ...over,
  };
  render(<GridOptionsMenu {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "More options" }));
  return props;
}

const item = (name: string | RegExp) => screen.getByRole("menuitem", { name });

describe("Grid options menu", () => {
  it("resets the view (spec: data-grid › Reset view)", () => {
    const p = mount();
    fireEvent.click(item("Reset view"));
    expect(p.onResetView).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("copies the query to a console and to the clipboard (spec: data-grid › Copy query to console)", () => {
    const p = mount();
    fireEvent.click(item("Copy query to console"));
    expect(p.onCopyQueryToConsole).toHaveBeenCalledWith(
      "SELECT * FROM orders WHERE status = 'new' ORDER BY id LIMIT 100;\n",
    );
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(item("Copy query to clipboard"));
    expect(p.onCopyQueryToClipboard).toHaveBeenCalledWith(
      "SELECT * FROM orders WHERE status = 'new' ORDER BY id LIMIT 100;\n",
    );
  });

  it("shows the statement in View query (spec: data-grid › Grid options menu)", () => {
    mount();
    fireEvent.click(item("View query"));
    expect(screen.getByRole("dialog", { name: "Query" })).toBeInTheDocument();
    expect(screen.getByLabelText("Query text")).toHaveTextContent(
      "SELECT * FROM orders WHERE status = 'new' ORDER BY id LIMIT 100;",
    );
  });

  it("disables what does not apply and says why (spec: data-grid › Grid options menu)", () => {
    mount({ query: null, onShowDdl: undefined, onRevealInExplorer: undefined, related: undefined });
    for (const n of ["View query", "Copy query to console", "Copy query to clipboard"]) {
      expect(item(n)).toBeDisabled();
      expect(item(n)).toHaveAttribute("title", "There is no query behind this result");
    }
    expect(item("Show DDL")).toBeDisabled();
    expect(item("Show DDL")).toHaveAttribute("title", "This result has no source table");
    expect(item("Reveal in explorer")).toBeDisabled();
    expect(item("Related rows")).toBeDisabled();
  });

  it("toggles the value editor and aggregate view (spec: data-grid › Grid options menu)", () => {
    const onToggleValueEditor = vi.fn();
    mount({
      onToggleValueEditor,
      valueEditorOpen: true,
      onToggleAggregate: vi.fn(),
      aggregateOpen: false,
    });
    expect(screen.getByRole("menuitemcheckbox", { name: "Value editor" })).toBeChecked();
    expect(screen.getByRole("menuitemcheckbox", { name: "Aggregate view" })).not.toBeChecked();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Value editor" }));
    expect(onToggleValueEditor).toHaveBeenCalled();
  });

  it("moves with the arrow keys and closes on Escape (spec: data-grid › Grid options menu)", () => {
    mount();
    expect(item("Reset view")).toHaveFocus();
    fireEvent.keyDown(item("Reset view"), { key: "ArrowDown" });
    expect(item("View query")).toHaveFocus();
    fireEvent.keyDown(item("View query"), { key: "Escape" });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "More options" })).toHaveFocus();
  });

  it("opens Go to row and selects row 150 (spec: data-grid › Go to row)", () => {
    const p = mount();
    fireEvent.click(item("Go to row…"));
    const box = screen.getByRole("textbox", { name: "Row or key" });
    fireEvent.change(box, { target: { value: "150" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(p.goTo!.onGo).toHaveBeenCalledWith({ kind: "row", row: 149, clamped: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens Go to row from a controlled flag, as Mod+G does (spec: data-grid › Go to row)", () => {
    const onGoToOpenChange = vi.fn();
    render(
      <GridOptionsMenu
        flavor="postgres"
        onResetView={() => {}}
        query={null}
        onCopyQueryToConsole={() => {}}
        onCopyQueryToClipboard={() => {}}
        goTo={{ rowCount: 10, onGo: () => {} }}
        goToOpen
        onGoToOpenChange={onGoToOpenChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onGoToOpenChange).toHaveBeenCalledWith(false);
  });

  it("opens the users table filtered to that user (spec: data-grid › Related rows)", () => {
    const p = mount({
      related: {
        foreignKeys: [
          { columns: ["user_id"], refSchema: "public", refTable: "users", refColumns: ["id"] },
        ],
        referencedBy: [
          { schema: "public", table: "order_items", columns: ["order_id"], refColumns: ["id"] },
        ],
        rowValue: (c) => row[c],
        column: "user_id",
        onOpenRelated: vi.fn(),
      },
    });
    expect(screen.queryByRole("menuitem", { name: /Referenced by/ })).not.toBeInTheDocument();
    fireEvent.click(item("References users (user_id)"));
    expect(p.related!.onOpenRelated).toHaveBeenCalledWith(
      'SELECT * FROM "public"."users" WHERE "id" = 42;',
      { schema: "public", name: "users" },
    );
  });

  it("lists referencing tables and disables a NULL key with the reason (spec: data-grid › Related rows)", () => {
    const p = mount({
      related: {
        foreignKeys: [
          { columns: ["user_id"], refSchema: null, refTable: "users", refColumns: ["id"] },
        ],
        referencedBy: [
          { schema: null, table: "order_items", columns: ["order_id"], refColumns: ["id"] },
        ],
        rowValue: (c) => (c === "user_id" ? { kind: "null" } : row[c]),
        onOpenRelated: vi.fn(),
      },
    });
    expect(item("References users (user_id)")).toBeDisabled();
    expect(item("References users (user_id)")).toHaveAttribute(
      "title",
      "The foreign key is NULL, so there are no related rows",
    );
    fireEvent.click(item("Referenced by order_items (order_id)"));
    expect(p.related!.onOpenRelated).toHaveBeenCalledWith(
      'SELECT * FROM "order_items" WHERE "order_id" = 7;',
      { schema: null, name: "order_items" },
    );
  });

  it("calls Show DDL and Reveal in explorer (spec: data-grid › Go to row and related rows)", () => {
    const p = mount();
    fireEvent.click(item("Show DDL"));
    expect(p.onShowDdl).toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "More options" }));
    fireEvent.click(item("Reveal in explorer"));
    expect(p.onRevealInExplorer).toHaveBeenCalled();
  });
});

describe("Go to row dialog", () => {
  it("clamps a row beyond the loaded rows (spec: data-grid › Go to row)", () => {
    const onGo = vi.fn();
    render(<GoToRowDialog rowCount={20} onGo={onGo} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Row or key" }), {
      target: { value: "999" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onGo).toHaveBeenCalledWith({ kind: "row", row: 19, clamped: true });
  });

  it("finds a key and keeps the dialog open with the reason when it is missing (spec: data-grid › Go to row)", () => {
    const onClose = vi.fn();
    const onGo = vi.fn(() => "No loaded row has that key");
    render(<GoToRowDialog rowCount={20} keyColumns={1} onGo={onGo} onClose={onClose} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Row or key" }), {
      target: { value: "key: 42" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(onGo).toHaveBeenCalledWith({ kind: "key", values: ["42"] });
    expect(screen.getByRole("alert")).toHaveTextContent("No loaded row has that key");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("rejects text that is not a row or key (spec: data-grid › Go to row)", () => {
    const onGo = vi.fn();
    render(<GoToRowDialog rowCount={20} onGo={onGo} onClose={() => {}} />);
    fireEvent.change(screen.getByRole("textbox", { name: "Row or key" }), {
      target: { value: "abc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a row number");
    expect(onGo).not.toHaveBeenCalled();
  });
});
