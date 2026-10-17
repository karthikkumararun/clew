import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Markdown, parseBlocks, tokenize } from "./markdown";

describe("parseBlocks", () => {
  it("splits paragraphs, lists and fenced code", () => {
    const blocks = parseBlocks(
      "carrier lives on shipments.\n\n- one\n- two\n\n```sql\nSELECT 1;\n```\n\nDone.",
    );
    expect(blocks).toEqual([
      { kind: "p", text: "carrier lives on shipments." },
      { kind: "ul", items: ["one", "two"] },
      { kind: "code", lang: "sql", text: "SELECT 1;", open: false },
      { kind: "p", text: "Done." },
    ]);
  });

  it("treats an unclosed fence as code to the end (an answer still streaming)", () => {
    expect(parseBlocks("text\n```sql\nSELECT")).toEqual([
      { kind: "p", text: "text" },
      { kind: "code", lang: "sql", text: "SELECT", open: true },
    ]);
  });

  it("reads numbered lists and headings", () => {
    expect(parseBlocks("## Plan\n1. a\n2) b")).toEqual([
      { kind: "heading", text: "Plan" },
      { kind: "ol", items: ["a", "b"] },
    ]);
  });
});

describe("tokenize", () => {
  it("marks keywords, strings, numbers and comments", () => {
    const kinds = tokenize("SELECT 'x', 42 -- hi").filter((t) => t.kind !== "plain");
    expect(kinds.map((t) => [t.kind, t.text])).toEqual([
      ["keyword", "SELECT"],
      ["string", "'x'"],
      ["number", "42"],
      ["comment", "-- hi"],
    ]);
  });
});

describe("Markdown", () => {
  it("renders inline code, bold and code blocks with Copy and Insert at cursor", () => {
    const onCopy = vi.fn();
    const onInsert = vi.fn();
    render(
      <Markdown
        text={"Use **o.id** and `s.carrier`:\n\n```sql\nSELECT o.id FROM orders o\n```"}
        actions={{ onCopy, onInsert }}
      />,
    );
    expect(screen.getByText("o.id").tagName).toBe("STRONG");
    expect(screen.getByText("s.carrier").tagName).toBe("CODE");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(onCopy).toHaveBeenCalledWith("SELECT o.id FROM orders o");
    fireEvent.click(screen.getByRole("button", { name: "Insert at cursor" }));
    expect(onInsert).toHaveBeenCalledWith("SELECT o.id FROM orders o");
  });

  it("offers no code actions while the block is still streaming", () => {
    render(<Markdown text={"```sql\nSELECT"} actions={{ onCopy: vi.fn() }} />);
    expect(screen.queryByRole("button", { name: "Copy" })).toBeNull();
  });

  it("never turns the answer into HTML", () => {
    const { container } = render(<Markdown text={"<img src=x onerror=alert(1)> <b>hi</b>"} />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("<img src=x");
  });
});
