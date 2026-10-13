import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ASYNC_THRESHOLD, aggregateClipboardText } from "../aggregate";
import type { AggregateResult } from "../aggregate";
import { dec, int, text } from "../testing";
import { AggregateStrip } from "./AggregateStrip";
import { dispatchShortcut } from "../../../../shell/registry/shortcuts";
import { registerAggregateShortcut } from "./aggregateShortcut";

describe("AggregateStrip", () => {
  it("shows exact aggregates (spec: data-grid › Selected numbers)", () => {
    render(
      <AggregateStrip
        count={2}
        getCells={() => [dec("1150.00"), dec("300.00")]}
        columnTypeName="numeric(10,2)"
      />,
    );
    const strip = screen.getByRole("status", { name: "Selection aggregate" });
    expect(strip).toHaveTextContent("2 cells");
    expect(strip).toHaveTextContent("COUNT 2");
    expect(strip).toHaveTextContent("SUM 1,450.00");
    expect(strip).toHaveTextContent("AVG 725.00");
    expect(strip).toHaveTextContent("MIN 300.00");
    expect(strip).toHaveTextContent("MAX 1,150.00");
  });

  it("shows only the cell count for text (spec: data-grid › No numbers)", () => {
    render(<AggregateStrip count={2} getCells={() => [text("a"), text("b")]} />);
    const strip = screen.getByRole("status", { name: "Selection aggregate" });
    expect(strip).toHaveTextContent("2 cells");
    expect(strip).not.toHaveTextContent("SUM");
    expect(screen.queryByRole("button", { name: "Copy sum" })).toBeNull();
  });

  it("renders nothing for a single cell and recomputes on selection change", () => {
    const { container, rerender } = render(<AggregateStrip count={1} getCells={() => [int(1)]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AggregateStrip count={2} getCells={() => [int(1), int(2)]} />);
    expect(screen.getByRole("status")).toHaveTextContent("SUM 3");
    rerender(<AggregateStrip count={2} selectionKey="b" getCells={() => [int(5), int(6)]} />);
    expect(screen.getByRole("status")).toHaveTextContent("SUM 11");
  });

  it("marks floats approximate", () => {
    render(
      <AggregateStrip
        count={2}
        getCells={() => [
          { kind: "float", value: 0.5 },
          { kind: "float", value: 0.25 },
        ]}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("approximate");
  });

  it("uses the async path with progress over 100,000 cells and reports the result", async () => {
    const n = ASYNC_THRESHOLD + 10;
    const onResult = vi.fn();
    const cells = function* () {
      for (let i = 0; i < n; i++) yield int(1);
    };
    render(<AggregateStrip count={n} getCells={cells} onResult={onResult} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent("Calculating");
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("SUM 100,010"));
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "false");
    const last = onResult.mock.lastCall?.[0] as AggregateResult;
    expect(aggregateClipboardText(last)).toBe("100010");
  });

  it("copies the SUM with Mod+Shift+C in the grid scope", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const off = registerAggregateShortcut(() => "1450.00");
    const ev = (key: string, mod: boolean) =>
      new KeyboardEvent("keydown", {
        key,
        code: "KeyC",
        metaKey: mod,
        ctrlKey: mod,
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      });
    act(() => {
      dispatchShortcut(ev("C", true), "grid");
    });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("1450.00"));
    off();
  });
});
