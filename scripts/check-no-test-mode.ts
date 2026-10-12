// Release builds must not contain e2e test mode (spec: e2e-testing › Isolated test mode › Release
// build has no test mode). Checks the Cargo feature tree and, when a binary exists, its bytes.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Strings that exist only when test mode or the WebDriver hooks are compiled in. */
export const FORBIDDEN = [
  "CLEW_E2E",
  "CLEW_DATA_DIR",
  "e2e-secrets.json",
  "tauri-plugin-wdio",
  "wdio-webdriver",
];

export function findForbidden(haystack: Buffer | string, needles = FORBIDDEN): string[] {
  const buf = typeof haystack === "string" ? Buffer.from(haystack) : haystack;
  return needles.filter((n) => buf.includes(n));
}

export function featureTreeProblems(tree: string): string[] {
  const problems: string[] = [];
  if (/clew v[\d.]+.*\n?.*feature "e2e"/.test(tree) || /feature "e2e"/.test(tree)) {
    problems.push('feature "e2e" is enabled');
  }
  if (/tauri-plugin-wdio/.test(tree)) problems.push("tauri-plugin-wdio is in the dependency tree");
  return problems;
}

function main(): number {
  const manifest = resolve("src-tauri", "Cargo.toml");
  const tree = execFileSync("cargo", ["tree", "-e", "features", "--manifest-path", manifest], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const problems = featureTreeProblems(tree).map((p) => `feature tree: ${p}`);

  const exe = process.platform === "win32" ? "clew.exe" : "clew";
  const candidates = process.argv.slice(2);
  if (candidates.length === 0) {
    candidates.push(
      resolve("src-tauri", "target", "release", exe),
      resolve("src-tauri", "target", "debug", exe),
    );
  }
  const binary = candidates.find((p) => existsSync(p));
  if (binary) {
    for (const hit of findForbidden(readFileSync(binary)))
      problems.push(`${binary}: contains "${hit}"`);
    console.log(`checked binary ${binary}`);
  } else {
    console.log("no built binary found; checked the feature tree only");
  }

  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length === 0) console.log("ok: no test mode in this build");
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
