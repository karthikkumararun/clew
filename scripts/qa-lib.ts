// Helpers for the local QA loop (spec: release-qa › One-command local QA stack).
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { journeyId } from "./e2e-lib";

export const PROFILES = ["core", "nosql", "graph", "heavy", "ai-mock"] as const;
export type Profile = (typeof PROFILES)[number];

export const QA_DIR = ".qa";
const STATE = join(QA_DIR, "stack.json");
const BUILD = join(QA_DIR, "build.json");

export function parseProfiles(arg: string | undefined, fallback: Profile[]): Profile[] {
  if (!arg) return fallback;
  const list = arg
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  const bad = list.filter((p) => !(PROFILES as readonly string[]).includes(p));
  if (bad.length)
    throw new Error(`unknown profile ${bad.join(", ")}; known: ${PROFILES.join(", ")}`);
  return list as Profile[];
}

/** Journeys whose container needs are not running are skipped, and listed. */
export function splitByProfiles(
  files: string[],
  needs: Record<string, string[]>,
  running: string[],
): { run: string[]; skipped: { file: string; missing: string[] }[] } {
  const run: string[] = [];
  const skipped: { file: string; missing: string[] }[] = [];
  for (const file of files) {
    const missing = (needs[journeyId(file)] ?? []).filter((p) => !running.includes(p));
    if (missing.length) skipped.push({ file, missing });
    else run.push(file);
  }
  return { run, skipped };
}

export function saveStack(profiles: Profile[]): void {
  mkdirSync(QA_DIR, { recursive: true });
  writeFileSync(STATE, JSON.stringify({ profiles, at: new Date().toISOString() }));
}

/** Profiles started by `qa:up`, or undefined when no stack was started through it. */
export function runningProfiles(): Profile[] | undefined {
  if (!existsSync(STATE)) return undefined;
  return (JSON.parse(readFileSync(STATE, "utf8")) as { profiles: Profile[] }).profiles;
}

export function clearStack(): void {
  writeFileSync(STATE, JSON.stringify({ profiles: [], at: new Date().toISOString() }));
}

export function dockerReachable(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore" }).status === 0;
}

export const DOCKER_HELP =
  "Docker is not reachable. Start Docker Desktop, OrbStack or Colima, wait until `docker info` works, then run this again.";

// --- build freshness -------------------------------------------------------------------------

const SOURCE_ROOTS = ["src", "src-tauri/src", "src-tauri/Cargo.toml", "src-tauri/Cargo.lock"];
const SOURCE_FILES = [
  "index.html",
  "package.json",
  "vite.config.ts",
  "src-tauri/tauri.conf.json",
  "src-tauri/tauri.e2e.conf.json",
  "src-tauri/build.rs",
];

function walk(path: string, out: string[]): void {
  if (!existsSync(path)) return;
  if (!statSync(path).isDirectory()) return void out.push(path);
  for (const name of readdirSync(path).sort()) {
    if (name === "node_modules" || name === "target" || name === "generated") continue;
    walk(join(path, name), out);
  }
}

/** Hash of everything that goes into the e2e app. Test files are left out: they do not change it. */
export function sourceHash(): string {
  const files: string[] = [];
  for (const r of SOURCE_ROOTS) walk(r, files);
  files.push(...SOURCE_FILES.filter(existsSync));
  const h = createHash("sha256");
  for (const f of files.filter((f) => !/\.test\.tsx?$/.test(f)).sort()) {
    h.update(f).update(readFileSync(f));
  }
  return h.digest("hex");
}

export const appBinary = () =>
  process.env.CLEW_E2E_BINARY ??
  join("src-tauri", "target", "debug", process.platform === "win32" ? "clew.exe" : "clew");

const fingerprint = (bin: string) => {
  const s = statSync(bin);
  return `${s.size}:${s.mtimeMs}`;
};

/**
 * Why the e2e app must be rebuilt, or undefined when it is fresh. A `cargo test` run rewrites the
 * same binary without the embedded frontend (a white window), so the binary itself is checked too.
 */
export function rebuildReason(): string | undefined {
  const bin = appBinary();
  if (!existsSync(bin)) return "no e2e app has been built";
  if (!existsSync(BUILD)) return "the build was not made through qa:e2e";
  const last = JSON.parse(readFileSync(BUILD, "utf8")) as { hash: string; binary: string };
  if (last.hash !== sourceHash()) return "the sources changed";
  if (last.binary !== fingerprint(bin)) return "the app binary was replaced since it was built";
  return undefined;
}

export function buildApp(): boolean {
  const r = spawnSync("pnpm", ["qa:build"], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) return false;
  mkdirSync(QA_DIR, { recursive: true });
  writeFileSync(BUILD, JSON.stringify({ hash: sourceHash(), binary: fingerprint(appBinary()) }));
  return true;
}

export const docker = (...args: string[]) => execFileSync("docker", args, { stdio: "inherit" });
