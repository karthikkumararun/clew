import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { browser } from "@wdio/globals";

export interface Region {
  height?: number;
  width?: number;
  radius?: number;
}

export interface Metrics {
  tolerancePx: number;
  regions: Record<string, Region>;
}

export const metrics = JSON.parse(
  readFileSync(resolve("design", "metrics.json"), "utf8"),
) as Metrics;

export interface Measured {
  width: number;
  height: number;
  radius: number;
}

/** Every element carrying `data-metric="<name>"`, measured as rendered. */
export async function measure(name: string): Promise<Measured[]> {
  return browser.execute((n: string) => {
    return Array.from(document.querySelectorAll(`[data-metric="${n}"]`)).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        width: r.width,
        height: r.height,
        radius: parseFloat(getComputedStyle(el).borderTopLeftRadius),
      };
    });
  }, name);
}

/** What differs from `design/metrics.json` by more than the tolerance; empty means it matches. */
export async function regionProblems(name: string): Promise<string[]> {
  const expected = metrics.regions[name];
  const found = await measure(name);
  if (found.length === 0) return [`no element with data-metric="${name}" is on screen`];
  const problems: string[] = [];
  for (const m of found) {
    for (const key of ["height", "width", "radius"] as const) {
      const want = expected[key];
      if (want !== undefined && Math.abs(m[key] - want) > metrics.tolerancePx) {
        problems.push(`${name}: expected ${key} ${want}px, measured ${m[key]}px`);
      }
    }
  }
  return problems;
}

/** Fails the test naming the region, the expected value and the measured value. */
export async function expectRegion(name: string): Promise<void> {
  const problems = await regionProblems(name);
  if (problems.length > 0) throw new Error(problems.join("; "));
}
