// The frontend half of `pnpm qa:build`: `pnpm build` with the e2e switch on. A script rather than
// `VITE_CLEW_E2E=1 pnpm build` in tauri.e2e.conf.json, because that syntax fails on Windows.
import { spawnSync } from "node:child_process";

const r = spawnSync("pnpm", ["build"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, VITE_CLEW_E2E: "1" },
});
process.exit(r.status ?? 1);
