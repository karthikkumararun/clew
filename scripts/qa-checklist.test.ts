// @coverage-ignore-file: fake scenario references on purpose
import { describe, expect, it } from "vitest";
import {
  computeCoverage,
  parseDeclarations,
  parseSpec,
  type SpecIndex,
} from "./check-scenario-coverage";
import { FIXED_MANUAL_CHECKS, renderChecklist } from "./qa-checklist";

const spec = `### Requirement: Greeting
The system SHALL greet.

#### Scenario: Hello
- **WHEN** a user arrives
- **THEN** it greets

#### Scenario: Goodbye
- **WHEN** a user leaves
- **THEN** it says bye

#### Scenario: Printed
<!-- manual -->
- **WHEN** it prints
- **THEN** the paper is warm
`;
const parsed = parseSpec(spec, "demo", "finished");
const index: SpecIndex = {
  scenarios: parsed.scenarios,
  requirements: new Map([["demo", new Set(parsed.requirements)]]),
};
const cover = (text: string, level: "unit" | "e2e") =>
  computeCoverage(index, parseDeclarations(text, "t.ts", level));

describe("manual checklist (spec: release-qa › Generate the checklist)", () => {
  it("lists scenarios without an e2e test, and manual ones, not e2e-covered ones", () => {
    const md = renderChecklist(index, cover('it("(spec: demo › Hello)")', "e2e"));
    expect(md).not.toContain("**Hello**");
    expect(md).toContain("- [ ] **Goodbye**");
    expect(md).toContain("- [ ] **Printed** _(manual)_");
    expect(md).toContain("  - WHEN a user leaves");
  });

  it("moves a unit-covered scenario to the compact section, without a checkbox or steps", () => {
    const md = renderChecklist(index, cover('it("(spec: demo › Goodbye)")', "unit"));
    expect(md).not.toContain("- [ ] **Goodbye**");
    expect(md).toContain("## Covered by unit or integration tests only (1)");
    expect(md).toContain("- Goodbye — Greeting _(unit)_");
    expect(md).not.toContain("  - WHEN a user leaves");
    // The one with no test at all still needs a person.
    expect(md).toContain("- [ ] **Printed** _(manual)_");
  });

  it("keeps a layout scenario that only a unit test saw on the person's list", () => {
    const layout = parseSpec(
      "### Requirement: Panel\nThe panel SHALL fit.\n\n#### Scenario: Narrow window\n- **WHEN** the window is narrowed\n- **THEN** the panel is fully visible and not clipped\n",
      "ui",
      "finished",
    );
    const idx: SpecIndex = {
      scenarios: layout.scenarios,
      requirements: new Map([["ui", new Set(layout.requirements)]]),
    };
    const md = renderChecklist(
      idx,
      computeCoverage(idx, parseDeclarations('it("(spec: ui › Narrow window)")', "t.ts", "unit")),
    );
    expect(md).toContain("- [ ] **Narrow window** _(only unit: check how it looks)_");
  });

  it("an e2e-covered scenario marked manual stays listed", () => {
    const md = renderChecklist(index, cover('it("(spec: demo › Printed)")', "e2e"));
    expect(md).toContain("**Printed** _(manual)_");
  });

  it("always has the fixed manual checks", () => {
    const md = renderChecklist(index, cover("", "e2e"));
    for (const c of FIXED_MANUAL_CHECKS) expect(md).toContain(c.title);
    expect(FIXED_MANUAL_CHECKS.length).toBeGreaterThanOrEqual(6);
  });
});
