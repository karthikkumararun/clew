// Flake bookkeeping across runs (spec: e2e-testing › Flake policy). Every e2e job uploads
// e2e/artifacts/summary.json; this script reads the summaries of the last 14 days, and for a
// journey that was flaky in three runs it opens a tracking issue. Moving the journey to
// e2e/quarantine.json stays a reviewed change: the issue says so.
// Usage: tsx scripts/e2e-flake.ts [--dry-run]     (needs `gh` and a token with issues:write)
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dueForQuarantine, type FlakyReport, type QuarantineEntry } from "./e2e-lib";

const gh = (...args: string[]) => execFileSync("gh", args, { encoding: "utf8" });

function recentReports(days: number): FlakyReport[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const runs = JSON.parse(
    gh(
      "run",
      "list",
      "--workflow",
      "e2e.yml",
      "--created",
      `>=${since}`,
      "--limit",
      "200",
      "--json",
      "databaseId",
    ),
  ) as { databaseId: number }[];
  const reports: FlakyReport[] = [];
  for (const run of runs) {
    const dir = mkdtempSync(join(tmpdir(), "e2e-summary-"));
    try {
      gh("run", "download", String(run.databaseId), "--pattern", "e2e-summary-*", "--dir", dir);
      for (const sub of readdirSync(dir)) {
        const s = JSON.parse(readFileSync(join(dir, sub, "summary.json"), "utf8")) as {
          runId: string;
          at: string;
          flaky: string[];
        };
        reports.push({ runId: `${run.databaseId}`, at: s.at, flaky: s.flaky });
      }
    } catch {
      // a run without summaries (cancelled, or smoke-less) has nothing to count
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return reports;
}

function main(): number {
  const dry = process.argv.includes("--dry-run");
  const quarantine = (
    JSON.parse(readFileSync("e2e/quarantine.json", "utf8")) as { quarantined: QuarantineEntry[] }
  ).quarantined;
  const due = dueForQuarantine(recentReports(14), quarantine, new Date());
  if (due.length === 0) {
    console.log("no journey was flaky in 3 runs within 14 days");
    return 0;
  }
  for (const journey of due) {
    const title = `Flaky e2e journey: ${journey}`;
    const body = [
      `${journey} passed only on retry in 3 or more runs within 14 days.`,
      "",
      "Per the flake policy: add it to `e2e/quarantine.json` (`journey`, this issue number, `since`),",
      "then fix or delete it within two weeks. A quarantined journey still runs but does not block.",
    ].join("\n");
    const open = gh(
      "issue",
      "list",
      "--state",
      "open",
      "--search",
      `"${title}" in:title`,
      "--json",
      "number",
    );
    if ((JSON.parse(open) as unknown[]).length > 0) {
      console.log(`${journey}: issue already open`);
    } else if (dry) {
      console.log(`would open: ${title}`);
    } else {
      gh("issue", "create", "--title", title, "--body", body);
      console.log(`opened: ${title}`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
