// Run the end-to-end journeys, one wdio run per spec file: each run starts the app once with its
// own temporary data directory, which is what keeps files isolated from each other.
// Usage: pnpm qa:e2e [filter ...]   (a filter matches part of a file name, e.g. J-03)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";

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

const SPECS = "e2e/specs";
const filters = process.argv.slice(2);
const files = readdirSync(SPECS)
  .filter((f) => f.endsWith(".e2e.ts"))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(x)))
  .sort();

if (files.length === 0) {
  console.error(`no journeys match ${filters.join(", ")}`);
  process.exit(2);
}

const results: { file: string; ok: boolean; seconds: number }[] = [];
for (const file of files) {
  await waitForPortFree(WEBDRIVER_PORT);
  const started = Date.now();
  console.log(`\n=== ${file}`);
  const r = spawnSync(
    "pnpm",
    ["exec", "wdio", "run", "e2e/wdio.conf.ts", "--spec", join(SPECS, file)],
    {
      stdio: "inherit",
      env: { ...process.env, CLEW_DATA_DIR: "", CLEW_E2E_DIALOG_QUEUE: "" },
    },
  );
  results.push({ file, ok: r.status === 0, seconds: Math.round((Date.now() - started) / 1000) });
}

console.log("\nJourneys:");
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.file}  (${r.seconds}s)`);
const failed = results.filter((r) => !r.ok).length;
console.log(`${results.length - failed} passed, ${failed} failed. Artifacts: e2e/artifacts/`);
process.exit(failed === 0 ? 0 : 1);
