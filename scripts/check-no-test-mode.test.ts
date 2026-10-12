import { describe, expect, it } from "vitest";
import { featureTreeProblems, findForbidden } from "./check-no-test-mode";

describe("release build has no test mode (spec: e2e-testing › Release build has no test mode)", () => {
  it("flags test-mode strings in a binary", () => {
    expect(findForbidden(Buffer.from("xx CLEW_E2E yy"))).toEqual(["CLEW_E2E"]);
    expect(findForbidden(Buffer.from("a clean binary"))).toEqual([]);
  });

  it("flags the e2e feature and the wdio plugin in the feature tree", () => {
    expect(featureTreeProblems('clew v0.1.0\n├── tauri feature "default"')).toEqual([]);
    expect(featureTreeProblems('clew v0.1.0 feature "e2e"').length).toBeGreaterThan(0);
    expect(featureTreeProblems("└── tauri-plugin-wdio v1.5.0").length).toBeGreaterThan(0);
  });
});
