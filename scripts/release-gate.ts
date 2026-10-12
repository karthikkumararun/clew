// Release gate (spec: release-qa › Release gate). A release is cut only when: no S1/S2 defect is
// open, the design review is approved (or has only S4 discrepancies), smoke is green on three OSes
// and full/heavy on Linux for the commit, the manual checklist was completed on macOS and Windows
// for the commit, and every scenario has a test level, a manual entry or a known gap.
// Usage: pnpm qa:gate <commit>        (needs `gh`; reads docs/qa/runs and docs/qa/design-review.json)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { collectDeclarations, computeCoverage, indexSpecs } from "./check-scenario-coverage";
import { analyse, type KnownGaps } from "./check-spec-completeness";

export interface Defect {
  number: number;
  title: string;
  labels: string[];
}

export interface Job {
  name: string;
  conclusion: string | null;
  url: string;
}

export interface DesignReview {
  commit: string;
  states: Record<string, "approved" | "discrepancies">;
  /** Filed discrepancies with their severity. */
  discrepancies?: { issue: number | string; severity: string }[];
}

export interface GateInput {
  commit: string;
  openDefects: Defect[];
  jobs: Job[];
  runFiles: { name: string; text: string }[];
  /** Scenarios with no test, no manual entry and no known gap. */
  unaccountedScenarios: string[];
  designReview?: DesignReview;
}

export interface GateResult {
  ok: boolean;
  failures: string[];
  evidence: string[];
}

export const REQUIRED_JOBS = [
  "smoke (macos-14)",
  "smoke (windows-latest)",
  "smoke (ubuntu-latest)",
  "design (macos-14, macos)",
  "design (ubuntu-latest, linux)",
  "design (windows-latest, windows-100, 1)",
  "design (windows-latest, windows-125, 1.25)",
  "design (windows-latest, windows-150, 1.5)",
  "full",
  "heavy",
];

const severityOf = (d: Defect) =>
  d.labels.find((l) => /^severity:S[1-4]$/.test(l))?.slice("severity:".length) ??
  /\bS[1-4]\b/.exec(d.title)?.[0];

const sameCommit = (text: string, commit: string) =>
  commit.length >= 7 && text.toLowerCase().includes(commit.toLowerCase().slice(0, 7));

export function evaluateGate(g: GateInput): GateResult {
  const failures: string[] = [];
  const evidence: string[] = [];

  const blocking = g.openDefects.filter((d) => ["S1", "S2"].includes(severityOf(d) ?? ""));
  for (const d of blocking) failures.push(`open ${severityOf(d)} defect #${d.number}: ${d.title}`);
  if (blocking.length === 0)
    evidence.push(`no open S1 or S2 defects (${g.openDefects.length} open defects)`);

  const dr = g.designReview;
  if (!dr) failures.push("no design review recorded (docs/qa/design-review.json)");
  else if (!sameCommit(dr.commit, g.commit)) {
    failures.push(`design review is for ${dr.commit}, not ${g.commit}`);
  } else {
    const open = Object.entries(dr.states).filter(([, v]) => v !== "approved");
    const bad = (dr.discrepancies ?? []).filter((d) => d.severity !== "S4");
    if (open.length > 0 && (dr.discrepancies ?? []).length === 0) {
      failures.push(`design review states not approved: ${open.map(([k]) => k).join(", ")}`);
    }
    for (const d of bad) failures.push(`design discrepancy ${d.issue} is ${d.severity}, not S4`);
    if (failures.every((f) => !f.startsWith("design"))) {
      evidence.push(
        `design review: ${Object.keys(dr.states).length} states, none with more than S4`,
      );
    }
  }

  for (const name of REQUIRED_JOBS) {
    const ok = g.jobs.find((j) => j.name === name && j.conclusion === "success");
    if (ok) evidence.push(`${name}: ${ok.url}`);
    else {
      const seen = g.jobs.find((j) => j.name === name);
      failures.push(
        `${name} ${seen ? `is ${seen.conclusion ?? "not finished"}` : "did not run"} for ${g.commit}`,
      );
    }
  }

  for (const platform of ["macos", "windows"]) {
    const file = g.runFiles.find(
      (f) => f.name.endsWith(`-${platform}.md`) && sameCommit(f.text, g.commit),
    );
    if (!file) {
      failures.push(
        `no manual checklist run for ${platform} at ${g.commit} (docs/qa/runs/<date>-${platform}.md)`,
      );
      continue;
    }
    const open = file.text.split("\n").filter((l) => /^\s*-\s\[ \]/.test(l) && !/#\d+/.test(l));
    if (open.length > 0) {
      failures.push(`${file.name}: ${open.length} unchecked items without a defect issue`);
    } else evidence.push(`checklist: docs/qa/runs/${file.name}`);
  }

  if (g.unaccountedScenarios.length > 0) {
    failures.push(
      `${g.unaccountedScenarios.length} scenarios have no test, no manual entry and no known gap (first: ${g.unaccountedScenarios[0]})`,
    );
  } else evidence.push("coverage: every scenario has a test level, a manual entry or a known gap");

  return { ok: failures.length === 0, failures, evidence };
}

// --- reading the world --------------------------------------------------------------------

const gh = (...a: string[]) =>
  execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function loadJobs(commit: string): Job[] {
  const runs = JSON.parse(
    gh(
      "run",
      "list",
      "--workflow",
      "e2e.yml",
      "--commit",
      commit,
      "--limit",
      "20",
      "--json",
      "databaseId",
    ),
  ) as { databaseId: number }[];
  const jobs: Job[] = [];
  for (const r of runs) {
    const v = JSON.parse(gh("run", "view", String(r.databaseId), "--json", "jobs")) as {
      jobs: { name: string; conclusion: string | null; url: string }[];
    };
    jobs.push(...v.jobs);
  }
  return jobs;
}

function unaccounted(root: string): string[] {
  const index = indexSpecs(root);
  const covered = new Set(computeCoverage(index, collectDeclarations(root)).byScenario.keys());
  const gapsFile = join(root, "docs", "qa", "known-gaps.json");
  const known: KnownGaps = existsSync(gapsFile)
    ? (JSON.parse(readFileSync(gapsFile, "utf8")) as KnownGaps)
    : { uncovered: [], requirementsWithoutScenario: [], underSpecified: [] };
  return analyse(index.scenarios, [], covered).uncovered.filter(
    (k) => !known.uncovered.some((g) => g.key === k),
  );
}

function main(): number {
  const commit = process.argv[2];
  if (!commit) {
    console.error("usage: release-gate.ts <commit sha>");
    return 2;
  }
  const root = resolve(".");
  const runsDir = join(root, "docs", "qa", "runs");
  const reviewFile = join(root, "docs", "qa", "design-review.json");
  const defects = (
    JSON.parse(
      gh(
        "issue",
        "list",
        "--label",
        "defect",
        "--state",
        "open",
        "--limit",
        "200",
        "--json",
        "number,title,labels",
      ),
    ) as { number: number; title: string; labels: { name: string }[] }[]
  ).map((d) => ({ number: d.number, title: d.title, labels: d.labels.map((l) => l.name) }));

  const result = evaluateGate({
    commit,
    openDefects: defects,
    jobs: loadJobs(commit),
    runFiles: existsSync(runsDir)
      ? readdirSync(runsDir)
          .filter((f) => f.endsWith(".md") && f !== "README.md")
          .map((name) => ({ name, text: readFileSync(join(runsDir, name), "utf8") }))
      : [],
    unaccountedScenarios: unaccounted(root),
    designReview: existsSync(reviewFile)
      ? (JSON.parse(readFileSync(reviewFile, "utf8")) as DesignReview)
      : undefined,
  });
  for (const e of result.evidence) console.log(`ok   ${e}`);
  for (const f of result.failures) console.error(`FAIL ${f}`);
  console.log(
    result.ok ? `\nRelease gate passed for ${commit}` : `\nRelease gate FAILED for ${commit}`,
  );
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
