// Sets the app version in every file that carries it, in one step, so the release workflow's
// tag check (scripts/release/cli.ts meta) passes.
//
//   pnpm release:bump 0.2.0 [--tag]
//
// Edits package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the `clew` entry of
// src-tauri/Cargo.lock. Nothing is written unless all four can be updated. With --tag it also
// commits "Release vX.Y.Z" and creates the tag `vX.Y.Z` (it never pushes).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cargoVersion } from "./lib";

// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;

export const isSemver = (v: string) => SEMVER.test(v);

const FILES = {
  pkg: "package.json",
  tauri: "src-tauri/tauri.conf.json",
  cargo: "src-tauri/Cargo.toml",
  lock: "src-tauri/Cargo.lock",
};

/** Replaces the top-level `"version"` of a JSON file, keeping its formatting. */
export function setJsonVersion(text: string, file: string, next: string): string {
  const current = (JSON.parse(text) as { version?: string }).version;
  if (typeof current !== "string") throw new Error(`${file}: no top-level "version" string`);
  const re = new RegExp(
    `^(\\s*"version"\\s*:\\s*")${current.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(")`,
    "m",
  );
  if (!re.test(text)) throw new Error(`${file}: cannot locate the version to replace`);
  return text.replace(re, `$1${next}$2`);
}

/** Replaces the version under `[package]` in a Cargo manifest. */
export function setCargoVersion(text: string, next: string): string {
  const re = /(\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m;
  if (!re.test(text)) throw new Error("Cargo.toml has no package version");
  return text.replace(re, `$1${next}$2`);
}

/** Moves the `clew` package of a Cargo.lock to `next`. */
export function setLockVersion(text: string, next: string): string {
  const re = /(\[\[package\]\]\nname = "clew"\nversion = ")[^"]+(")/;
  if (!re.test(text)) throw new Error("Cargo.lock has no clew package");
  return text.replace(re, `$1${next}$2`);
}

/** Computes all new contents first and writes only if every file succeeded. */
export function bumpVersion(root: string, next: string): string[] {
  if (!isSemver(next)) {
    throw new Error(`"${next}" is not a version (expected MAJOR.MINOR.PATCH[-prerelease])`);
  }
  const read = (f: string) => readFileSync(join(root, f), "utf8");
  const current = cargoVersion(read(FILES.cargo));
  if (current === next) throw new Error(`the version is already ${next}`);
  const edits: [string, string][] = [
    [FILES.pkg, setJsonVersion(read(FILES.pkg), FILES.pkg, next)],
    [FILES.tauri, setJsonVersion(read(FILES.tauri), FILES.tauri, next)],
    [FILES.cargo, setCargoVersion(read(FILES.cargo), next)],
    [FILES.lock, setLockVersion(read(FILES.lock), next)],
  ];
  for (const [file, content] of edits) writeFileSync(join(root, file), content);
  return edits.map(([f]) => f);
}

function main(argv: string[]): number {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const version = argv.find((a) => !a.startsWith("--"))?.replace(/^v/, "");
  if (!version) {
    console.error("usage: pnpm release:bump <X.Y.Z> [--tag]");
    return 2;
  }
  try {
    const files = bumpVersion(root, version);
    console.log(`Set version ${version} in:\n${files.map((f) => `  ${f}`).join("\n")}`);
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
  if (argv.includes("--tag")) {
    const git = (...a: string[]) => execFileSync("git", a, { cwd: root, stdio: "inherit" });
    git("add", ...Object.values(FILES));
    git("commit", "-m", `Release v${version}`);
    git("tag", `v${version}`);
    console.log(`Committed and tagged v${version}. Push with: git push origin HEAD v${version}`);
  } else {
    console.log(`Next: commit, merge, then: git tag v${version} && git push origin v${version}`);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
