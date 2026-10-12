import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createDataDir } from "./helpers/dataDir";
import { redact } from "../scripts/e2e-lib";

const exe = process.platform === "win32" ? "clew.exe" : "clew";
const binary = process.env.CLEW_E2E_BINARY ?? resolve("src-tauri", "target", "debug", exe);

// Test mode is read by the app at start-up (src-tauri/src/testmode.rs). The service spawns the
// app with this process's environment, so set it before the first launch.
// The launcher creates the profile; workers inherit it through the environment (this file loads in both).
const fresh = !process.env.CLEW_DATA_DIR;
const data = fresh ? createDataDir() : undefined;
if (data) {
  process.env.CLEW_DATA_DIR = data.dir;
  process.env.CLEW_E2E_DIALOG_QUEUE = data.dialogQueue;
}
process.env.CLEW_E2E = "1";
// DataGrip import reads this fixture instead of the developer's real settings (J-10).
process.env.CLEW_E2E_DATAGRIP_ROOT = resolve("e2e", "fixtures", "datagrip", "JetBrains");
mkdirSync(resolve("e2e", "artifacts"), { recursive: true });

// Retries get their own artifact names so the first failure is not overwritten.
const attempt = process.env.CLEW_E2E_ATTEMPT ?? "1";
const stamp = (name: string) => `e2e/artifacts/${name}`;
const slug = (s: string) => s.replace(/[^\w-]+/g, "_");
/** Step trace and logs go through redact(): artifacts are uploaded and must hold no secrets. */
const trace = (line: string) =>
  appendFileSync(stamp(`trace-a${attempt}.log`), `${new Date().toISOString()} ${redact(line)}\n`);

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts", "./design/**/*.e2e.ts"],
  maxInstances: 1,
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application: binary },
    } as WebdriverIO.Capabilities,
  ],
  services: [["@wdio/tauri-service", { driverProvider: "embedded" }]],
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: { ui: "bdd", timeout: 60_000 },
  logLevel: "warn",
  outputDir: resolve("e2e", "artifacts", "wdio-logs"),
  beforeTest: (test) => trace(`START ${test.parent} > ${test.title}`),
  // Per failed test: a screenshot of the window, the browser console and a trace line
  // (spec: e2e-testing › Failure artifacts).
  afterTest: async (test, _context, result) => {
    trace(
      `${result.passed ? "PASS " : "FAIL "} ${test.parent} > ${test.title} (${result.duration}ms)`,
    );
    if (result.passed || (test as { pending?: boolean }).pending) return;
    const name = slug(`${test.parent} ${test.title}`);
    await browser.saveScreenshot(stamp(`FAIL-a${attempt}-${name}.png`)).catch(() => {});
    // The embedded WebDriver may not offer log retrieval; the console log is best effort.
    try {
      const logs = await (browser as unknown as { getLogs(t: string): Promise<unknown[]> }).getLogs(
        "browser",
      );
      writeFileSync(
        stamp(`FAIL-a${attempt}-${name}.console.log`),
        redact(JSON.stringify(logs, null, 2)),
      );
    } catch {
      trace("console log unavailable from this WebDriver");
    }
    if (result.error) trace(`ERROR ${String(result.error.message).split("\n")[0]}`);
  },
  logLevels: { webdriver: "silent" }, // restarts make the old session fail on purpose
  // Stop the app at the end: after `launchApp` it is not the service's child, and an app holding an
  // open transaction would otherwise refuse to quit and linger.
  after: async () => {
    await browser
      .execute(() => {
        const w = window as unknown as {
          __TAURI__: { core: { invoke(c: string): Promise<void> } };
        };
        void w.__TAURI__.core.invoke("e2e_exit");
      })
      .catch(() => {});
  },
  onComplete: () => data?.cleanup(),
};
