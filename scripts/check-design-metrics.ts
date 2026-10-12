// Cross-check design/metrics.json with src/styles/tokens.css and the design README
// (spec: design-conformance › Machine-readable design metrics). Usage: pnpm check:design-metrics
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export interface Region {
  height?: number;
  width?: number;
  min?: number;
  max?: number;
  radius?: number;
  token?: string;
}

export interface Metrics {
  tolerancePx: number;
  regions: Record<string, Region>;
  notRendered?: Record<string, Region>;
}

/** Value of a `--token: 12px` declaration, in px. */
export function tokenPx(css: string, name: string): number | undefined {
  const m = new RegExp(`${name.replace(/[-]/g, "\\-")}\\s*:\\s*(\\d+(?:\\.\\d+)?)px`).exec(css);
  return m ? Number(m[1]) : undefined;
}

export function metricProblems(metrics: Metrics, css: string): string[] {
  const problems: string[] = [];
  const all = { ...metrics.regions, ...(metrics.notRendered ?? {}) };
  for (const [name, r] of Object.entries(all)) {
    if (!r.token) continue;
    const value = tokenPx(css, r.token);
    const expected = r.height ?? r.width ?? r.radius;
    if (value === undefined) problems.push(`${name}: token ${r.token} is not in tokens.css`);
    else if (value !== expected) {
      problems.push(`${name}: metrics.json says ${expected}px, ${r.token} is ${value}px`);
    }
  }
  return problems;
}

function main(): number {
  const metrics = JSON.parse(readFileSync(resolve("design", "metrics.json"), "utf8")) as Metrics;
  const css = readFileSync(resolve("src", "styles", "tokens.css"), "utf8");
  const problems = metricProblems(metrics, css);
  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length === 0) console.log("ok: design/metrics.json agrees with tokens.css");
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
