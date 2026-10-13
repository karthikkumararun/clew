import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ColumnarStore } from "../../source";
import { col, text } from "../testing";
import { FindBar } from "./FindBar";

function store() {
  const s = new ColumnarStore([col("id"), col("status")]);
  const statuses = ["shipped", "new", "shipped", "x", "shipping", "new", "ship it", "y"];
  s.append(statuses.map((v, i) => [text(String(i)), text(v)]));
  return s;
}

describe("FindBar", () => {
  it("finds a value, counts 3 of 8-style matches and Enter jumps on (spec: data-grid › Find a value)", () => {
    const s = new ColumnarStore([col("status")]);
    const vals = [
      "ship a",
      "x",
      "ship b",
      "ship c",
      "y",
      "ship d",
      "ship e",
      "ship f",
      "ship g",
      "ship h",
    ];
    s.append(vals.map((v) => [text(v)]));
    const onNavigate = vi.fn();
    const onMatches = vi.fn();
    render(<FindBar source={s} onNavigate={onNavigate} onMatches={onMatches} onClose={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Find in results" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "ship" } });
    expect(screen.getByRole("status", { name: "Find result" })).toHaveTextContent("1 of 8");
    expect(onNavigate).toHaveBeenLastCalledWith(0, 0);
    const lookup = onMatches.mock.lastCall?.[0] as (r: number, c: number) => boolean;
    expect(lookup(0, 0)).toBe(true);
    expect(lookup(1, 0)).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("status", { name: "Find result" })).toHaveTextContent("2 of 8");
    expect(onNavigate).toHaveBeenLastCalledWith(2, 0);
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByRole("status", { name: "Find result" })).toHaveTextContent("1 of 8");
  });

  it("applies the options and reports invalid patterns", () => {
    render(<FindBar source={store()} onNavigate={() => {}} onClose={() => {}} />);
    const input = screen.getByRole("textbox", { name: "Find in results" });
    const label = () => screen.getByRole("status", { name: "Find result" });
    fireEvent.change(input, { target: { value: "ship" } });
    expect(label()).toHaveTextContent("1 of 4");
    fireEvent.click(screen.getByRole("button", { name: "Whole word" }));
    expect(label()).toHaveTextContent("1 of 1");
    fireEvent.click(screen.getByRole("button", { name: "Whole word" }));
    fireEvent.click(screen.getByRole("button", { name: "Match case" }));
    fireEvent.change(input, { target: { value: "SHIP" } });
    expect(label()).toHaveTextContent("No results");
    fireEvent.click(screen.getByRole("button", { name: "Regular expression" }));
    fireEvent.change(input, { target: { value: "(" } });
    expect(label()).toHaveTextContent("Invalid pattern");
    expect(input).toHaveAttribute("aria-invalid", "true");
  });

  it("closes on Esc and clears highlights", () => {
    const onClose = vi.fn();
    const onMatches = vi.fn();
    const { unmount } = render(
      <FindBar source={store()} onNavigate={() => {}} onMatches={onMatches} onClose={onClose} />,
    );
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Find in results" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(onMatches).toHaveBeenLastCalledWith(null, null);
  });
});
