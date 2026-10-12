import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  blockingFailures,
  dueForQuarantine,
  flaky,
  redact,
  selectJourneys,
  summaryMarkdown,
  type JourneyResult,
} from "./e2e-lib";

const suites = { smoke: ["J-01", "J-03"], heavy: ["J-20"] };
const files = [
  "J-01-first-run.e2e.ts",
  "J-03-console.e2e.ts",
  "J-05-table.e2e.ts",
  "J-20-big.e2e.ts",
];
const res = (file: string, attempts: boolean[], quarantined = false): JourneyResult => ({
  file,
  attempts,
  seconds: 1,
  quarantined,
});

describe("suites (spec: e2e-testing › Suites and triggers)", () => {
  it("smoke picks its journeys, full excludes heavy, heavy picks heavy", () => {
    expect(selectJourneys(files, suites, "smoke")).toEqual([files[0], files[1]]);
    expect(selectJourneys(files, suites, "full")).toEqual(files.slice(0, 3));
    expect(selectJourneys(files, suites, "heavy")).toEqual([files[3]]);
  });

  it("a filter narrows a suite", () => {
    expect(selectJourneys(files, suites, "smoke", ["J-03"])).toEqual([files[1]]);
  });
});

describe("flake policy (spec: e2e-testing › Passes on retry)", () => {
  it("a journey that fails then passes is flaky and does not fail the run", () => {
    const r = res(files[0], [false, true]);
    expect(flaky(r)).toBe(true);
    expect(blockingFailures([r])).toEqual([]);
    expect(summaryMarkdown("smoke", [r])).toContain("PASS (flaky: passed on retry)");
  });

  it("a journey that fails twice blocks, unless quarantined", () => {
    expect(blockingFailures([res(files[0], [false, false])])).toHaveLength(1);
    expect(blockingFailures([res(files[0], [false, false], true)])).toHaveLength(0);
  });
});

describe("quarantine (spec: e2e-testing › Repeated flake)", () => {
  const now = new Date("2026-10-20T00:00:00Z");
  const rep = (runId: string, at: string, f: string[]) => ({ runId, at, flaky: f });

  it("flags a journey flaky in three runs within 14 days", () => {
    const reports = [
      rep("1", "2026-10-10T00:00:00Z", ["J-05"]),
      rep("2", "2026-10-15T00:00:00Z", ["J-05", "J-03"]),
      rep("3", "2026-10-19T00:00:00Z", ["J-05"]),
    ];
    expect(dueForQuarantine(reports, [], now)).toEqual(["J-05"]);
  });

  it("ignores old runs and already quarantined journeys", () => {
    const reports = [
      rep("1", "2026-09-01T00:00:00Z", ["J-05"]),
      rep("2", "2026-10-15T00:00:00Z", ["J-05"]),
      rep("3", "2026-10-19T00:00:00Z", ["J-05"]),
    ];
    expect(dueForQuarantine(reports, [], now)).toEqual([]);
    const three = [...reports.slice(1), rep("4", "2026-10-18T00:00:00Z", ["J-05"])];
    expect(dueForQuarantine(three, [{ journey: "J-05", issue: 1, since: "x" }], now)).toEqual([]);
  });
});

describe("failure artifacts (spec: e2e-testing › Failure artifacts)", () => {
  it("redacts credentials from logs", () => {
    expect(redact("password=hunter2 next")).toBe("password=[redacted] next");
    expect(redact('{"apiKey": "abc123"}')).toContain("[redacted]");
    expect(redact("Authorization: Bearer abc.def.ghi")).toBe("Authorization: Bearer [redacted]");
    expect(redact("key sk-ant-1234567890")).toBe("key [redacted]");
    expect(redact("plain line")).toBe("plain line");
  });
});

describe("e2e workflow triggers (spec: e2e-testing › Ordinary pull request)", () => {
  const text = readFileSync(resolve(__dirname, "..", ".github", "workflows", "e2e.yml"), "utf8");
  const on = text.slice(text.indexOf("\non:"), text.indexOf("\npermissions:"));

  it("starts on release branches, nightly and manual dispatch only", () => {
    expect(on).toContain("release/**");
    expect(on).toContain("schedule:");
    expect(on).toContain("workflow_dispatch:");
    expect(on).not.toMatch(/pull_request/);
  });

  it("the ordinary CI workflow never starts the e2e suites", () => {
    const ci = readFileSync(resolve(__dirname, "..", ".github", "workflows", "ci.yml"), "utf8");
    expect(ci).not.toMatch(/qa:e2e|e2e\.yml/);
  });
});
