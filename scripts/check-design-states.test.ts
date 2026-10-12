import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canvasScreens, registryIds, stateProblems, type StatesFile } from "./check-design-states";

describe("design state matrix (spec: design-conformance › Screen state matrix)", () => {
  const file: StatesFile = {
    screens: { Main: { states: [{ id: "main-a" }] }, Later: { pending: "add-later" } },
  };

  it("passes when every screen is listed and every state has a fixture", () => {
    expect(stateProblems(["Main", "Later"], file, ["main-a"])).toEqual([]);
  });

  it("fails and names a canvas screen added without states (spec: design-conformance › New canvas screen)", () => {
    const p = stateProblems(["Main", "Later", "Fresh"], file, ["main-a"]);
    expect(p).toEqual(["canvas screen Fresh has no entry in design/states.json"]);
  });

  it("fails a listed state with no fixture, and a screen that is not on the canvas", () => {
    expect(stateProblems(["Main", "Later"], file, [])[0]).toContain("main-a has no fixture");
    expect(stateProblems(["Main"], file, ["main-a"])[0]).toContain("not a canvas screen");
  });

  it("the repository's states.json, canvas folder and registry agree", () => {
    const real = JSON.parse(readFileSync(resolve("design", "states.json"), "utf8")) as StatesFile;
    const canvas = canvasScreens(["Welcome.dc.html"]);
    expect(canvas).toEqual(["Welcome"]);
    const ids = registryIds(
      readFileSync(resolve("e2e", "fixtures", "states", "registry.ts"), "utf8"),
    );
    expect(ids.length).toBeGreaterThan(5);
    for (const s of real.screens.Welcome.states ?? []) expect(ids).toContain(s.id);
  });
});
