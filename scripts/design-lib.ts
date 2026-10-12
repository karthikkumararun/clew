// Image comparison for the design review (spec: design-conformance › Visual regression baselines).
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";

export interface Mask {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Comparison {
  /** The images could be compared (same size). */
  comparable: boolean;
  diffPixels: number;
  totalPixels: number;
  /** Share of pixels that differ, 0..1. */
  ratio: number;
  /** Difference image with changed pixels in red. */
  diff?: PNG;
}

/** 0.1% of pixels (spec: design-conformance › Visual regression baselines). */
export const TOLERANCE = 0.001;

/** Paint the masked rectangles the same colour in both images so they never differ. */
export function applyMasks(img: PNG, masks: Mask[]): PNG {
  const out = new PNG({ width: img.width, height: img.height });
  img.data.copy(out.data);
  for (const m of masks) {
    for (let y = Math.max(0, m.y); y < Math.min(img.height, m.y + m.height); y++) {
      for (let x = Math.max(0, m.x); x < Math.min(img.width, m.x + m.width); x++) {
        const i = (img.width * y + x) << 2;
        out.data[i] = out.data[i + 1] = out.data[i + 2] = 128;
        out.data[i + 3] = 255;
      }
    }
  }
  return out;
}

/** Window sizes can differ by a pixel or two between runs (title bar, rounding): compare their common top-left area. */
export const SIZE_SLACK = 8;

export function cropTo(img: PNG, width: number, height: number): PNG {
  if (img.width === width && img.height === height) return img;
  const out = new PNG({ width, height });
  PNG.bitblt(img, out, 0, 0, width, height, 0, 0);
  return out;
}

export function compare(a0: PNG, b0: PNG, masks: Mask[] = []): Comparison {
  if (Math.abs(a0.width - b0.width) > SIZE_SLACK || Math.abs(a0.height - b0.height) > SIZE_SLACK) {
    return { comparable: false, diffPixels: 0, totalPixels: 0, ratio: 1 };
  }
  const width = Math.min(a0.width, b0.width);
  const height = Math.min(a0.height, b0.height);
  const a = cropTo(a0, width, height);
  const b = cropTo(b0, width, height);
  const ma = applyMasks(a, masks);
  const mb = applyMasks(b, masks);
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(ma.data, mb.data, diff.data, a.width, a.height, { threshold: 0.1 });
  const totalPixels = a.width * a.height;
  return { comparable: true, diffPixels, totalPixels, ratio: diffPixels / totalPixels, diff };
}

export const passes = (c: Comparison, tolerance = TOLERANCE) =>
  c.comparable && c.ratio <= tolerance;

export const decode = (buf: Buffer) => PNG.sync.read(buf);
export const encode = (img: PNG) => PNG.sync.write(img);
