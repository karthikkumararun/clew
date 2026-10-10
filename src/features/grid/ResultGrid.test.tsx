import { render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Value } from "../../lib/ipc/drivers";
import { ResultGrid } from "./ResultGrid";
import { ColumnarStore } from "./source";

/** A canvas context that accepts every call; the grid paints nothing we can assert on in jsdom. */
function fakeContext() {
  return new Proxy(
    { canvas: document.createElement("canvas") },
    {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        if (prop === "measureText") return (t: string) => ({ width: t.length * 7 });
        if (prop === "createLinearGradient" || prop === "createPattern")
          return () => ({ addColorStop() {} });
        return () => {};
      },
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

beforeAll(() => {
  HTMLCanvasElement.prototype.getContext = (() => fakeContext()) as never;
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
});
afterEach(() => vi.restoreAllMocks());

const int = (n: number): Value => ({ kind: "int", value: n });

describe("ResultGrid (smoke)", () => {
  it("mounts over a store and survives new rows and hidden columns", () => {
    const store = new ColumnarStore([
      { name: "id", type_name: "int8", kind: "int", nullable: false },
      { name: "name", type_name: "text", kind: "text", nullable: true },
    ]);
    store.append([
      [int(1), { kind: "text", value: "Ada" }],
      [int(2), { kind: "null" }],
    ]);
    const { container, rerender } = render(<ResultGrid source={store} driver="postgres" />);
    // Glide draws its canvas once it has a size; jsdom has no layout, so assert on the wrapper
    // it renders, which carries the token-derived theme.
    const root = container.querySelector("[data-testid='result-grid'] > div") as HTMLElement;
    expect(root).not.toBeNull();
    expect(root.getAttribute("style")).toContain("--gdg-text-dark");
    store.append([[int(3), { kind: "text", value: "Grace" }]]);
    rerender(<ResultGrid source={store} driver="postgres" hidden={new Set([1])} />);
    expect(container.querySelector("[data-testid='result-grid'] > div")).not.toBeNull();
  });
});
