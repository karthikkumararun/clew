import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const exe = process.platform === "win32" ? "clew.exe" : "clew";
const binary = process.env.CLEW_E2E_BINARY ?? resolve("src-tauri", "target", "debug", exe);

// Test mode is read by the app at start-up (src-tauri/src/testmode.rs). The service spawns the
// app with this process's environment, so set it before the first launch.
export const dataDir = (process.env.CLEW_DATA_DIR ??= mkdtempSync(join(tmpdir(), "clew-e2e-")));
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
};
