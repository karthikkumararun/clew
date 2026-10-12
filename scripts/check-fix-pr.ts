// Fix pull request check (spec: release-qa › Fix pull request check). Applies to pull requests
// from `fix/*` branches or labelled `defect`. Usage in CI: tsx scripts/check-fix-pr.ts <event.json>
import { execFileSync } from "node:child_process";

export interface FixPr {
  branch: string;
  labels: string[];
  body: string;
  /** Changed file paths. */
  files: string[];
  /** Added lines of the diff (used to spot Rust tests written inside source files). */
  addedLines: string;
}

export const isFixPr = (pr: FixPr) => pr.branch.startsWith("fix/") || pr.labels.includes("defect");

const TEST_FILE =
  /(\.test\.[cm]?[tj]sx?$|\.spec\.[cm]?[tj]sx?$|(^|\/)e2e\/specs\/|(^|\/)tests\/[^/]+\.rs$|_test\.rs$|(^|\/)openspec\/.*\/spec\.md$)/;
const RUST_TEST = /#\[(tokio::)?test\b/;

export function changesATest(pr: FixPr): boolean {
  return pr.files.some((f) => TEST_FILE.test(f)) || RUST_TEST.test(pr.addedLines);
}

/** The reason under a "No automated test" heading, if any text follows it. */
export function noAutomatedTestReason(body: string): string | undefined {
  const m = /^#{1,6}\s*No automated test\s*$([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im.exec(body);
  const text = (m?.[1] ?? "").replace(/<!--[\s\S]*?-->/g, "").trim();
  return text.length >= 10 ? text : undefined;
}

/** What is missing from the pull request; empty means it passes. */
export function fixPrProblems(pr: FixPr): string[] {
  if (!isFixPr(pr)) return [];
  const problems: string[] = [];
  if (!changesATest(pr) && !noAutomatedTestReason(pr.body)) {
    problems.push('it changes no test file and has no "No automated test" section with a reason');
  }
  if (!/(^|[^\w])(#\d+|https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+)/.test(pr.body)) {
    problems.push("it does not link an issue (for example `Issue: #27`)");
  }
  if (!/[\w-]+\s*›\s*[^\n]*\S/.test(pr.body)) {
    problems.push("it names no spec scenario (`capability › Scenario name`)");
  }
  if (!/\b(C[1-6]|NEW)\b/.test(pr.body)) {
    problems.push("it states no defect class (C1-C6 or NEW, see docs/qa/defect-classes.md)");
  }
  return problems;
}

function main(): number {
  const number = process.argv[2];
  if (!number) {
    console.error("usage: check-fix-pr.ts <pull request number>");
    return 2;
  }
  const gh = (...a: string[]) =>
    execFileSync("gh", a, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const view = JSON.parse(gh("pr", "view", number, "--json", "headRefName,labels,body,files")) as {
    headRefName: string;
    labels: { name: string }[];
    body: string;
    files: { path: string }[];
  };
  const diff = gh("pr", "diff", number);
  const pr: FixPr = {
    branch: view.headRefName,
    labels: view.labels.map((l) => l.name),
    body: view.body ?? "",
    files: view.files.map((f) => f.path),
    addedLines: diff
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .join("\n"),
  };
  if (!isFixPr(pr)) {
    console.log("not a fix pull request: nothing to check");
    return 0;
  }
  const problems = fixPrProblems(pr);
  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length === 0)
    console.log("ok: fix pull request has its test, issue, scenario and class");
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
