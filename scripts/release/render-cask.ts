// Renders the Homebrew cask from packaging/homebrew/clew.rb.tmpl using only the release version
// and the .dmg entry of SHA256SUMS.txt (spec: homebrew-packaging › Cask rendering).
//
//   tsx scripts/release/render-cask.ts --version 0.2.0 --checksums SHA256SUMS.txt \
//     [--signed] [--out Casks/clew.rb]
//
// Exits non-zero (and writes nothing) for a pre-release or invalid version, a missing .dmg entry
// or a digest that is not 64 hex characters. Prints the cask to stdout without --out. Mirrors
// mergeIQ's render-cask.mjs; Clew's placeholders are @NAME@ so Homebrew's own {{appdir}} can
// never be replaced by accident.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const TEMPLATE_PATH = join(here, "../../packaging/homebrew/clew.rb.tmpl");

/** Only stable releases reach the tap: MAJOR.MINOR.PATCH with no suffix. */
export const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const dmgName = (version: string) => `Clew_${version}_universal.dmg`;

/** `{ name: digest }` from `sha256sum` output (`<digest>  <name>`, optional `*` binary mark). */
export function parseChecksums(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(\S+) [ *](.+)$/);
    if (match) entries[match[2]] = match[1];
  }
  return entries;
}

/**
 * Until the app is signed and notarized the cask clears macOS's quarantine attribute itself, so a
 * Homebrew install opens without the Gatekeeper warning. (Acceptable in our own tap only.)
 */
export const UNSIGNED_POSTFLIGHT = `

  postflight_steps do
    run "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", "{{appdir}}/Clew.app"]
  end`;

/** Explains the postflight, what to do for a manual download, and what uninstall leaves behind. */
export const UNSIGNED_CAVEATS = `

  caveats <<~EOS
    Clew is not signed or notarized yet. This cask clears macOS's quarantine attribute for you,
    so it opens normally after installing. If you downloaded the .dmg yourself instead, right-click
    the app and choose Open the first time, or run:
      xattr -dr com.apple.quarantine /Applications/Clew.app

    Saved connection passwords stay in the keychain (service "Clew") after uninstalling; remove
    them in Keychain Access. Your SQL scripts in ~/Documents/Clew are never removed.
  EOS`;

export interface RenderInput {
  template: string;
  version: string;
  checksums: string;
  signed?: boolean;
}

/** Validates the inputs and returns the cask text; throws an Error naming the problem. */
export function renderCask({ template, version, checksums, signed }: RenderInput): string {
  if (!STABLE_VERSION.test(version)) {
    throw new Error(
      `refusing to render a cask for "${version}": only stable MAJOR.MINOR.PATCH releases are published to the tap`,
    );
  }
  const asset = dmgName(version);
  const sha256 = parseChecksums(checksums)[asset];
  if (sha256 === undefined) throw new Error(`SHA256SUMS.txt has no entry for ${asset}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`the digest for ${asset} is not 64 lowercase hex characters: "${sha256}"`);
  }
  return template
    .replaceAll("@VERSION@", version)
    .replaceAll("@SHA256@", sha256)
    .replace("\n@POSTFLIGHT@", signed ? "" : UNSIGNED_POSTFLIGHT)
    .replace("\n@CAVEATS@", signed ? "" : UNSIGNED_CAVEATS);
}

function main(argv: string[]): number {
  const arg = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const version = arg("--version");
  const checksumsFile = arg("--checksums");
  if (!version || !checksumsFile) {
    console.error(
      "usage: render-cask.ts --version <X.Y.Z> --checksums <file> [--signed] [--out <file>]",
    );
    return 2;
  }
  let cask: string;
  try {
    cask = renderCask({
      template: readFileSync(TEMPLATE_PATH, "utf8"),
      version,
      checksums: readFileSync(resolve(checksumsFile), "utf8"),
      signed: argv.includes("--signed"),
    });
  } catch (error) {
    console.error(`render-cask: ${(error as Error).message}`);
    return 1;
  }
  const out = arg("--out");
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true });
    writeFileSync(resolve(out), cask);
  } else {
    process.stdout.write(cask);
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
