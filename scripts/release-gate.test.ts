import { describe, expect, it } from "vitest";
import { REQUIRED_JOBS, evaluateGate, type GateInput } from "./release-gate";

const COMMIT = "abc1234def5678";
const green: GateInput = {
  commit: COMMIT,
  openDefects: [{ number: 5, title: "typo", labels: ["defect", "severity:S4"] }],
  jobs: REQUIRED_JOBS.map((name) => ({ name, conclusion: "success", url: `https://ci/${name}` })),
  runFiles: [
    { name: "2026-10-20-macos.md", text: `Build: 0.1.0 (${COMMIT.slice(0, 7)})\n- [x] one\n` },
    {
      name: "2026-10-20-windows.md",
      text: `Build: 0.1.0 (${COMMIT.slice(0, 7)})\n- [x] one\n- [ ] two #12\n`,
    },
  ],
  unaccountedScenarios: [],
  designReview: { commit: COMMIT.slice(0, 7), states: { Welcome: "approved" } },
};

describe("release gate (spec: release-qa › Release gate)", () => {
  it("passes and prints the evidence when everything is satisfied (spec: release-qa › All green)", () => {
    const r = evaluateGate(green);
    expect(r.failures).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.evidence.join("\n")).toContain("https://ci/smoke (macos-14)");
    expect(r.evidence.join("\n")).toContain("2026-10-20-windows.md");
  });

  it("fails on an open S2 defect and names the issue (spec: release-qa › Open S2 defect)", () => {
    const r = evaluateGate({
      ...green,
      openDefects: [{ number: 27, title: "export loses rows", labels: ["defect", "severity:S2"] }],
    });
    expect(r.ok).toBe(false);
    expect(r.failures.join("\n")).toContain("#27");
  });

  it("fails when a required job did not run or did not succeed", () => {
    const jobs = green.jobs
      .filter((j) => j.name !== "heavy")
      .map((j) => (j.name === "full" ? { ...j, conclusion: "failure" } : j));
    const f = evaluateGate({ ...green, jobs }).failures.join("\n");
    expect(f).toContain("heavy did not run");
    expect(f).toContain("full is failure");
  });

  it("needs a checklist run for each platform at this commit, with no unchecked item lacking an issue", () => {
    expect(
      evaluateGate({ ...green, runFiles: green.runFiles.slice(0, 1) }).failures.join(),
    ).toContain("windows");
    const stale = [{ name: "x-macos.md", text: "Build: other" }, green.runFiles[1]];
    expect(evaluateGate({ ...green, runFiles: stale }).failures.join()).toContain("macos");
    const open = [
      green.runFiles[0],
      { name: "x-windows.md", text: `${COMMIT.slice(0, 7)}\n- [ ] untouched\n` },
    ];
    expect(evaluateGate({ ...green, runFiles: open }).failures.join()).toContain("unchecked");
  });

  it("fails without a design review, for another commit, or with a discrepancy above S4", () => {
    expect(evaluateGate({ ...green, designReview: undefined }).ok).toBe(false);
    expect(evaluateGate({ ...green, designReview: { commit: "ffffff0", states: {} } }).ok).toBe(
      false,
    );
    const s3 = {
      commit: COMMIT,
      states: { Grid: "discrepancies" as const },
      discrepancies: [{ issue: 9, severity: "S3" }],
    };
    expect(evaluateGate({ ...green, designReview: s3 }).failures.join()).toContain("S3");
    const s4 = { ...s3, discrepancies: [{ issue: 9, severity: "S4" }] };
    expect(evaluateGate({ ...green, designReview: s4 }).ok).toBe(true);
  });

  it("fails when a scenario has no test, no manual entry and no known gap", () => {
    const r = evaluateGate({ ...green, unaccountedScenarios: ["demo›R›Lost"] });
    expect(r.failures.join()).toContain("demo›R›Lost");
  });
});
