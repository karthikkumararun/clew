import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { applyMasks, compare, passes } from "./design-lib";

function image(w: number, h: number, paint?: (x: number, y: number) => number[] | undefined): PNG {
  const img = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = paint?.(x, y) ?? [20, 23, 28];
      const i = (w * y + x) << 2;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = 255;
    }
  }
  return img;
}
const bar = (top: number) => (x: number, y: number) =>
  y >= top && y < top + 20 && x > 10 && x < 190 ? [230, 232, 235] : undefined;

describe("visual regression (spec: design-conformance › Visual regression baselines)", () => {
  it("passes identical images", () => {
    expect(passes(compare(image(200, 100, bar(10)), image(200, 100, bar(10))))).toBe(true);
  });

  it("fails an element moved by 6px and returns a diff image (spec: design-conformance › Unintended visual change)", () => {
    const c = compare(image(200, 100, bar(10)), image(200, 100, bar(16)));
    expect(passes(c)).toBe(false);
    expect(c.diff).toBeDefined();
    expect(c.diffPixels).toBeGreaterThan(0);
  });

  it("ignores changes under a mask and tolerates 0.1% of pixels", () => {
    const a = image(200, 100, bar(10));
    const b = image(200, 100, bar(16));
    expect(passes(compare(a, b, [{ x: 0, y: 0, width: 200, height: 60 }]))).toBe(true);
    const tiny = image(200, 100, (x, y) => (x < 3 && y < 3 ? [255, 0, 0] : undefined));
    expect(compare(image(200, 100), tiny).ratio).toBeLessThan(0.001);
    expect(passes(compare(image(200, 100), tiny))).toBe(true);
  });

  it("does not compare images of very different sizes, but allows a pixel or two", () => {
    expect(passes(compare(image(10, 10), image(40, 10)))).toBe(false);
    expect(passes(compare(image(100, 100, bar(10)), image(100, 98, bar(10))))).toBe(true);
  });

  it("masks leave the input untouched", () => {
    const a = image(10, 10);
    const m = applyMasks(a, [{ x: 0, y: 0, width: 5, height: 5 }]);
    expect(m.data[0]).toBe(128);
    expect(a.data[0]).toBe(20);
  });
});
