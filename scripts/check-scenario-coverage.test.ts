// @coverage-ignore-file: fake scenario references on purpose
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectDeclarations,
  computeCoverage,
  indexSpecs,
  isLayoutClass,
  needsRealRender,
  parseDeclarations,
  renderReport,
} from "./check-scenario-coverage";

const root = resolve(__dirname, "fixtures", "traceability");

describe("scenario traceability (spec: e2e-testing › Scenario traceability)", () => {
  it("reads (spec: …) and covers(…) declarations", () => {
    const text = [
      'describe("x (spec: demo › Hello; demo › Greeting › Goodbye)", () => {});',
      'it(`y ${covers("demo › Hello", "demo › Goodbye")}`, () => {});',
    ].join("\n");
    const refs = parseDeclarations(text, "a.ts", "e2e").map((d) => d.ref);
    expect(refs).toEqual([
      "demo › Hello",
      "demo › Greeting › Goodbye",
      "demo › Hello",
      "demo › Goodbye",
    ]);
  });

  it("fails on a renamed scenario and names the file and scenario (spec: e2e-testing › Renamed scenario)", () => {
    const index = indexSpecs(root);
    const decls = parseDeclarations('it("(spec: demo › Hi there)")', "old.test.ts", "unit");
    const { dangling } = computeCoverage(index, decls);
    expect(dangling).toHaveLength(1);
    expect(dangling[0].declaration.file).toBe("old.test.ts");
    expect(dangling[0].reason).toContain("Hi there");
  });

  it("rejects an unknown capability and a malformed reference", () => {
    const index = indexSpecs(root);
    const decls = parseDeclarations('x("(spec: nope › Hello; Hello)")', "a.ts", "unit");
    expect(computeCoverage(index, decls).dangling).toHaveLength(2);
  });

  it("lists uncovered scenarios in the report (spec: e2e-testing › Coverage report)", () => {
    const index = indexSpecs(root);
    const decls = parseDeclarations('it("(spec: demo › Hello)")', "a.test.ts", "unit");
    const report = renderReport(index, computeCoverage(index, decls));
    expect(report).toContain("| Greeting | Hello | unit |");
    expect(report).toContain("| Greeting | Goodbye | **manual (no test)** |");
  });

  it("a requirement-level reference covers all its scenarios", () => {
    const index = indexSpecs(root);
    const decls = parseDeclarations('it("(spec: demo › Greeting)")', "a.test.ts", "unit");
    expect(computeCoverage(index, decls).byScenario.size).toBe(2);
  });

  it("every declaration in this repository still resolves", () => {
    const repo = resolve(__dirname, "..");
    const { dangling } = computeCoverage(indexSpecs(repo), collectDeclarations(repo));
    expect(dangling.map((d) => `${d.declaration.file}: ${d.declaration.ref}`)).toEqual([]);
  });

  it("marks a layout scenario covered only by a component test (spec: e2e-testing › Layout scenario with only a component test)", () => {
    const layout = {
      capability: "demo",
      requirement: "R",
      name: "Default layout",
      steps: ["WHEN the app opens", "THEN the tab strip is 36px high"],
      manual: false,
      status: "finished" as const,
    };
    expect(isLayoutClass(layout)).toBe(true);
    expect(needsRealRender(layout, new Set(["unit"]))).toBe(true);
    expect(needsRealRender(layout, new Set(["unit", "e2e"]))).toBe(false);
    expect(needsRealRender(layout, new Set(["design"]))).toBe(false);
    expect(needsRealRender(layout, undefined)).toBe(false);
    expect(isLayoutClass({ ...layout, name: "Run", steps: ["THEN rows are returned"] })).toBe(
      false,
    );
  });
});
