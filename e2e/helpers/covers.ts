/**
 * Declare the spec scenarios a test covers: `it(`runs a query ${covers("sql-console › Run a statement")}`, …)`.
 * The text lands in the test title, so reports show it, and `scripts/check-scenario-coverage.ts`
 * reads it. Vitest names use the same `(spec: capability › Scenario)` form.
 */
export function covers(...scenarios: string[]): string {
  return `(spec: ${scenarios.join("; ")})`;
}
