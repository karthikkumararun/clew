// @coverage-ignore-file: fake scenario references on purpose
import { describe, expect, it } from "vitest";
import { fixPrProblems, type FixPr } from "./check-fix-pr";

const GOOD_BODY = `## Fix
- Issue: #27
- Spec scenario: \`app-shell › Toggle the sidebar\`
- Defect class: C2
`;
const base: FixPr = {
  branch: "fix/27-sidebar",
  labels: [],
  body: GOOD_BODY,
  files: ["src/shell/Sidebar.tsx", "src/shell/layout.test.tsx"],
  addedLines: "",
};

describe("fix pull request check (spec: release-qa › Fix pull request check)", () => {
  it("passes with a test, issue, scenario and class", () => {
    expect(fixPrProblems(base)).toEqual([]);
  });

  it("ignores pull requests that are not fixes", () => {
    expect(fixPrProblems({ ...base, branch: "feat/x", body: "", files: ["a.ts"] })).toEqual([]);
  });

  it("checks a pull request labelled defect on any branch", () => {
    expect(
      fixPrProblems({ ...base, branch: "x", labels: ["defect"], body: "" }).length,
    ).toBeGreaterThan(0);
  });

  it("fails a fix with only source changes and no No-automated-test section (spec: release-qa › Fix without a test)", () => {
    const p = fixPrProblems({ ...base, files: ["src/shell/Sidebar.tsx"] });
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("changes no test file");
  });

  it("accepts a No automated test section with a reason", () => {
    const body = `${GOOD_BODY}\n### No automated test\nThe defect is a native dialog; added to the manual checklist.\n`;
    expect(fixPrProblems({ ...base, files: ["src/a.ts"], body })).toEqual([]);
  });

  it("rejects an empty No automated test section", () => {
    const body = `${GOOD_BODY}\n### No automated test\n<!-- reason -->\n`;
    expect(fixPrProblems({ ...base, files: ["src/a.ts"], body })).toHaveLength(1);
  });

  it("counts a Rust test written inside a source file", () => {
    expect(
      fixPrProblems({
        ...base,
        files: ["src-tauri/src/a.rs"],
        addedLines: "+    #[test]\n+    fn x() {}",
      }),
    ).toEqual([]);
  });

  it("counts a spec scenario added with the fix (spec: release-qa › Spec scenario added with the fix)", () => {
    expect(
      fixPrProblems({
        ...base,
        files: ["openspec/changes/fix-x/specs/app-shell/spec.md", "src/a.ts"],
      }),
    ).toEqual([]);
  });

  it("names every missing part", () => {
    const p = fixPrProblems({ ...base, body: "just a fix", files: ["a.ts"] });
    expect(p).toHaveLength(4);
  });
});
