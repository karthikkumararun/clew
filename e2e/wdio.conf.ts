import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createDataDir } from "./helpers/dataDir";

const exe = process.platform === "win32" ? "clew.exe" : "clew";
const binary = process.env.CLEW_E2E_BINARY ?? resolve("src-tauri", "target", "debug", exe);

// Test mode is read by the app at start-up (src-tauri/src/testmode.rs). The service spawns the
// app with this process's environment, so set it before the first launch.
// The launcher creates the profile; workers inherit it through the environment (this file loads in both).
const fresh = process.env.CLEW_DATA_DIR === undefined;
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
  logLevels: { webdriver: "silent" }, // restarts make the old session fail on purpose
  // `launchApp` restarts the app, and the new process is not the service's child: stop it here.
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
