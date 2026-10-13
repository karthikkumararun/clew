// Start the local QA stack: certificates, chosen Compose profiles, wait until healthy, check the
// seed (spec: release-qa › One-command local QA stack).
// Usage: pnpm qa:up [--profiles core,nosql,graph]      (default: core,nosql,ai-mock)
import { spawnSync } from "node:child_process";
import {
  DOCKER_HELP,
  dockerReachable,
  parseProfiles,
  saveStack,
  docker,
  type Profile,
} from "./qa-lib";

function main(): number {
  const arg = process.argv.slice(2);
  const i = arg.findIndex((a) => a === "--profiles" || a.startsWith("--profiles="));
  const value = i < 0 ? undefined : arg[i].includes("=") ? arg[i].split("=")[1] : arg[i + 1];
  let profiles: Profile[];
  try {
    profiles = parseProfiles(value, ["core", "nosql", "ai-mock"]);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }

  if (!dockerReachable()) {
    console.error(DOCKER_HELP); // nothing else has been done
    return 1;
  }

  const certs = spawnSync("sh", ["scripts/gen-test-certs.sh"], { stdio: "inherit" });
  if (certs.status !== 0) {
    console.error("could not generate the test certificates and keys");
    return 1;
  }

  const flags = profiles.flatMap((p) => ["--profile", p]);
  try {
    docker("compose", ...flags, "up", "-d", "--build", "--wait");
  } catch {
    console.error("the stack did not become healthy; see `docker compose logs`");
    return 1;
  }
  saveStack(profiles);

  // The seed is loaded into a fresh database per test file; this proves the databases agree.
  const parity = spawnSync("pnpm", ["qa:parity"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (parity.status !== 0) {
    console.error("seed parity failed; fix the seed before running journeys");
    return 1;
  }
  console.log(`\nQA stack is up (${profiles.join(", ")}). Next: pnpm qa:e2e --suite full`);
  return 0;
}

process.exit(main());
