// Run the end-to-end journeys, one wdio run per spec file: each run starts the app once with its
// own temporary data directory, which is what keeps files isolated from each other.
// Usage: pnpm qa:e2e [--suite smoke|full|heavy|design] [--retries N] [filter ...]
// A filter matches part of a file name, e.g. J-03. A failed journey is retried once by default
// (spec: e2e-testing › Flake policy); journeys in e2e/quarantine.json are reported but never block.
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { buildApp, rebuildReason, runningProfiles, splitByProfiles } from "./qa-lib";
import {
  blockingFailures,
  flaky,
  journeyId,
  passed,
  selectJourneys,
  summaryMarkdown,
  type JourneyResult,
  type QuarantineEntry,
  type SuiteName,
  type Suites,
} from "./e2e-lib";

const WEBDRIVER_PORT = 4445;

/** The previous app stops a moment after its run ends; the next run needs the port back. */
async function waitForPortFree(port: number, timeoutMs = 15_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const busy = await new Promise<boolean>((resolve) => {
      const s = createConnection({ port, host: "127.0.0.1" });
      s.once("connect", () => (s.destroy(), resolve(true)));
      s.once("error", () => resolve(false));
    });
    if (!busy) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`port ${port} is still in use: is another Clew e2e app running?`);
}

// The design suite lives beside the journeys, in its own folder (spec: e2e-testing › Suites and triggers).
const specsDir = (suite?: string) => (suite === "design" ? "e2e/design" : "e2e/specs");

function parseArgs(argv: string[]) {
  let suite: SuiteName | undefined;
  let retries = 1;
  const filters: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = (name: string) =>
      a.startsWith(`${name}=`) ? a.slice(name.length + 1) : a === name ? argv[++i] : undefined;
    const s = value("--suite");
    const r = value("--retries");
    if (s !== undefined) {
      if (!["smoke", "full", "heavy", "design"].includes(s))
        throw new Error(`unknown suite "${s}"`);
      suite = s as SuiteName;
    } else if (r !== undefined) retries = Number(r);
    else filters.push(a);
  }
  return { suite, retries, filters };
}

const { suite, retries, filters } = parseArgs(process.argv.slice(2));
const suites = JSON.parse(readFileSync("e2e/suites.json", "utf8")) as Suites;
const quarantine = (
  JSON.parse(readFileSync("e2e/quarantine.json", "utf8")) as { quarantined: QuarantineEntry[] }
).quarantined;
const selected = selectJourneys(
  readdirSync(specsDir(suite)).filter((f) => f.endsWith(".e2e.ts")),
  suites,
  suite,
  filters,
);

// A stack started with `pnpm qa:up --profiles …` limits which journeys can run; journeys that
// need other profiles are skipped and listed (spec: release-qa › Selecting profiles). Smoke runs
// use SQLite and need no containers.
const running = runningProfiles();
const { run: files, skipped } =
  suite === "smoke" || running === undefined
    ? { run: selected, skipped: [] }
    : splitByProfiles(selected, suites.needs ?? {}, running);
for (const s of skipped) console.log(`SKIP ${s.file}: needs profile ${s.missing.join(", ")}`);

if (files.length === 0) {
  if (suite === "heavy" && filters.length === 0) {
    console.log("no heavy journeys are defined yet");
    process.exit(0);
  }
  console.error(`no journeys match ${[suite, ...filters].filter(Boolean).join(" ")}`);
  process.exit(2);
}

const reason = process.env.CLEW_E2E_BINARY ? undefined : rebuildReason();
if (reason) {
  console.log(`Building the e2e app: ${reason}`);
  if (!buildApp()) {
    console.error("the e2e app did not build");
    process.exit(1);
  }
}

mkdirSync("e2e/artifacts", { recursive: true });
const results: JourneyResult[] = [];
for (const file of files) {
  const started = Date.now();
  const attempts: boolean[] = [];
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForPortFree(WEBDRIVER_PORT);
    console.log(`\n=== ${file}${attempt ? ` (retry ${attempt})` : ""}`);
    const r = spawnSync(
      "pnpm",
      ["exec", "wdio", "run", "e2e/wdio.conf.ts", "--spec", join(specsDir(suite), file)],
      {
        stdio: "inherit",
        // pnpm is a .cmd shim on Windows
        shell: process.platform === "win32",
        env: {
          ...process.env,
          CLEW_DATA_DIR: "",
          CLEW_E2E_DIALOG_QUEUE: "",
          CLEW_E2E_ATTEMPT: String(attempt + 1),
          // the smoke suite runs without containers: its journeys use SQLite
          ...(suite === "smoke" ? { CLEW_E2E_DIALECT: "sqlite" } : {}),
          ...(suites.keychain?.includes(journeyId(file)) ? { CLEW_E2E_KEYCHAIN: "1" } : {}),
        },
      },
    );
    attempts.push(r.status === 0);
    if (r.status === 0) break;
  }
  results.push({
    file,
    attempts,
    seconds: Math.round((Date.now() - started) / 1000),
    quarantined: quarantine.some((q) => q.journey === journeyId(file)),
  });
}

const label = suite ?? "custom";
const skippedList = skipped.length
  ? `\n### Skipped (profile not running)\n${skipped.map((s) => `- ${s.file}: ${s.missing.join(", ")}`).join("\n")}\n`
  : "";
const markdown = summaryMarkdown(label, results) + skippedList;
console.log(`\n${markdown}`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
writeFileSync(
  "e2e/artifacts/summary.json",
  JSON.stringify(
    {
      suite: label,
      runId: process.env.GITHUB_RUN_ID ?? "local",
      at: new Date().toISOString(),
      os: process.platform,
      results,
      flaky: results.filter(flaky).map((r) => journeyId(r.file)),
      skipped: skipped.map((s) => journeyId(s.file)),
      failed: results.filter((r) => !passed(r)).map((r) => journeyId(r.file)),
    },
    null,
    2,
  ),
);
const failed = blockingFailures(results);
console.log(
  `${results.filter(passed).length} passed, ${failed.length} failed. Artifacts: e2e/artifacts/`,
);
process.exit(failed.length === 0 ? 0 : 1);
