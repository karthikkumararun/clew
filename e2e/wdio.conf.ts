import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDataDir } from "./helpers/dataDir";

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
mkdirSync(resolve("e2e", "artifacts"), { recursive: true });

export const config: WebdriverIO.Config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.ts"],
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
  // A screenshot of every failed test, named after it (spec: e2e-testing › Failure artifacts).
  afterTest: async (test, _context, result) => {
    if (result.passed) return;
    const name = `${test.parent} ${test.title}`.replace(/[^\w-]+/g, "_");
    await browser.saveScreenshot(`e2e/artifacts/FAIL-${name}.png`).catch(() => {});
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
