// @coverage-ignore-file: fake scenario references on purpose
import { describe, expect, it } from "vitest";
import { parseSpec } from "./check-scenario-coverage";
import {
  analyse,
  closedGaps,
  enumeratedItems,
  newGaps,
  parseRequirements,
  unmatchedPhrases,
} from "./check-spec-completeness";

const SPEC = `### Requirement: Explorer groups
The explorer SHALL show connections in groups; default groups follow environment (local, development, staging, production).

#### Scenario: Create a group
- **WHEN** the user creates a group
- **THEN** it appears

### Requirement: Lonely
The system SHALL do a thing.
`;
const scenarios = parseSpec(SPEC, "demo", "finished").scenarios;
const reqs = parseRequirements(SPEC, "demo", "finished");
const none = { uncovered: [], requirementsWithoutScenario: [], underSpecified: [] };

describe("spec-to-test completeness (spec: e2e-testing › Spec-to-test completeness)", () => {
  it("counts listed items in parentheses and 'such as' lists", () => {
    expect(enumeratedItems("kinds (a, b, c and d)")).toBe(4);
    expect(enumeratedItems("shows things such as one, two and three.")).toBe(3);
    expect(enumeratedItems("plain prose")).toBe(0);
  });

  it("flags a prose claim without a scenario (spec: e2e-testing › Prose claim without a scenario)", () => {
    const prose = reqs[0].prose;
    expect(unmatchedPhrases(prose, "Create a group the user creates a group it appears")).toContain(
      "default groups",
    );
    const f = analyse(scenarios, reqs, new Set());
    expect(f.underSpecified.some((u) => u.why.includes("default groups"))).toBe(true);
  });

  it("lists requirements without any scenario", () => {
    expect(analyse(scenarios, reqs, new Set()).requirementsWithoutScenario).toEqual([
      "demo›Lonely",
    ]);
  });

  it("fails on a new gap and passes on a known one (spec: e2e-testing › Known gaps cannot grow silently)", () => {
    const f = analyse(scenarios, reqs, new Set());
    expect(newGaps(f, none).length).toBeGreaterThan(0);
    const known = {
      uncovered: f.uncovered.map((key) => ({ key, reason: "baseline" })),
      requirementsWithoutScenario: f.requirementsWithoutScenario.map((key) => ({
        key,
        reason: "baseline",
      })),
      underSpecified: f.underSpecified.map((u) => ({
        key: `${u.key}›${u.why}`,
        reason: "baseline",
      })),
    };
    expect(newGaps(f, known)).toEqual([]);
  });

  it("reports baseline entries whose gap is closed", () => {
    const known = {
      ...none,
      uncovered: [{ key: "demo›Explorer groups›Create a group", reason: "x" }],
    };
    const f = analyse(scenarios, reqs, new Set(["demo›Explorer groups›Create a group"]));
    expect(closedGaps(f, known)).toEqual(["demo›Explorer groups›Create a group"]);
  });
});
