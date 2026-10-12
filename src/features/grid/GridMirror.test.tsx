import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { GridMirror, MIRROR_ROWS } from "./GridMirror";
import type { GridSource } from "./source";

function source(rows: number): GridSource {
  return {
    columns: [{ name: "id" }, { name: "name" }],
    rowCount: rows,
    get: (c: number, r: number) =>
      c === 0 ? { kind: "int", value: r } : { kind: "text", value: `u${r}` },
  } as unknown as GridSource;
}

describe("grid mirror (spec: e2e-testing › Real-app end-to-end harness)", () => {
  it("repeats cell text as DOM rows so WebDriver can read the canvas grid", () => {
    render(<GridMirror source={source(3)} visible={[0, 1]} />);
    expect(screen.getAllByTestId("grid-row")).toHaveLength(3);
    expect(screen.getAllByTestId("grid-cell")[1]).toHaveTextContent("u0");
    expect(screen.getByTestId("grid-mirror")).toHaveAttribute("data-row-count", "3");
  });

  it("caps the mirrored rows but reports the full count", () => {
    render(<GridMirror source={source(100_000)} visible={[0]} />);
    expect(screen.getAllByTestId("grid-row")).toHaveLength(MIRROR_ROWS);
    expect(screen.getByTestId("grid-mirror")).toHaveAttribute("data-row-count", "100000");
  });
});
