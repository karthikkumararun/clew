import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { metricProblems, tokenPx, type Metrics } from "./check-design-metrics";

describe("design metrics (spec: design-conformance › Machine-readable design metrics)", () => {
  it("reads token values in px", () => {
    expect(tokenPx("--h-titlebar: 44px;", "--h-titlebar")).toBe(44);
    expect(tokenPx("--x: 1px", "--h-titlebar")).toBeUndefined();
  });

  it("design/metrics.json agrees with tokens.css", () => {
    const metrics = JSON.parse(readFileSync(resolve("design", "metrics.json"), "utf8")) as Metrics;
    const css = readFileSync(resolve("src", "styles", "tokens.css"), "utf8");
    expect(metricProblems(metrics, css)).toEqual([]);
  });

  it("names a region whose metric and token disagree", () => {
    const metrics: Metrics = {
      tolerancePx: 1,
      regions: { toolbar: { height: 44, token: "--h-titlebar" } },
    };
    expect(metricProblems(metrics, "--h-titlebar: 40px;")[0]).toContain("toolbar");
  });
});
