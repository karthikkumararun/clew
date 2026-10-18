// Pure helpers of the release pipeline (spec: release-packaging). The workflow calls them
// through `scripts/release/cli.ts`; they are separate so they can be tested.
import { createHash } from "node:crypto";

export interface ReleaseMeta {
  /** `0.1.0` */
  version: string;
  /** `v0.1.0` */
  tag: string;
  /** `0.1.0-beta.1` style versions are pre-releases. */
  prerelease: boolean;
}

/** `v1.2.3` or `v1.2.3-beta.1`. */
const TAG = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export class ReleaseError extends Error {}

/**
 * The tag must be a version tag and equal the version of every file that carries one, so a
 * release can't ship an installer that says 0.1.0 under the tag v0.2.0.
 */
export function checkTag(tag: string, versions: Record<string, string>): ReleaseMeta {
  const m = TAG.exec(tag);
  if (!m) throw new ReleaseError(`"${tag}" is not a version tag like v1.2.3 or v1.2.3-beta.1`);
  const version = m[1];
  const wrong = Object.entries(versions).filter(([, v]) => v !== version);
  if (wrong.length > 0) {
    throw new ReleaseError(
      `tag ${tag} does not match: ${wrong.map(([f, v]) => `${f} says ${v}`).join(", ")}`,
    );
  }
  return { version, tag, prerelease: version.includes("-") };
}

/** The version of Cargo.toml's `[package]`. */
export function cargoVersion(toml: string): string {
  const pkg = /\[package\][\s\S]*?^version\s*=\s*"([^"]+)"/m.exec(toml);
  if (!pkg) throw new ReleaseError("Cargo.toml has no package version");
  return pkg[1];
}

export type Platform = "universal" | "x64";

/** What the Tauri bundler writes, and what the release calls it. */
export interface Asset {
  /** Name on the release: `Clew_<version>_<platform>.<ext>`. */
  name: string;
  /** Path the bundler wrote. */
  from: string;
}

const norm = (p: string) => p.replace(/\\/g, "/");

/**
 * Map bundler output paths to release names. macOS gives the `.dmg` and the updater archive
 * (`Clew.app.tar.gz` + `.sig`); Windows gives the NSIS setup, the MSI and the NSIS signature.
 * Unknown files are left out.
 */
export function releaseAssets(version: string, files: string[]): Asset[] {
  const out: Asset[] = [];
  for (const raw of files) {
    const f = norm(raw);
    const base = f.slice(f.lastIndexOf("/") + 1);
    let name: string | null = null;
    if (/\.dmg$/.test(base)) name = `Clew_${version}_universal.dmg`;
    else if (/\.app\.tar\.gz$/.test(base)) name = `Clew_${version}_universal.app.tar.gz`;
    else if (/\.app\.tar\.gz\.sig$/.test(base)) name = `Clew_${version}_universal.app.tar.gz.sig`;
    else if (/-setup\.exe$/.test(base)) name = `Clew_${version}_x64.exe`;
    else if (/-setup\.exe\.sig$/.test(base)) name = `Clew_${version}_x64.exe.sig`;
    else if (/\.msi$/.test(base)) name = `Clew_${version}_x64.msi`;
    if (name) out.push({ name, from: raw });
  }
  return out;
}

/** The contents of `SHA256SUMS.txt`: `<hash>  <file>`, sorted by file name. */
export function checksumLines(entries: { name: string; data: Buffer | string }[]): string {
  return (
    [...entries]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => `${createHash("sha256").update(e.data).digest("hex")}  ${e.name}`)
      .join("\n") + "\n"
  );
}

export interface ManifestInput {
  version: string;
  notes: string;
  /** ISO date of publication. */
  date: string;
  repo: string;
  tag: string;
  /** Contents of the `.sig` files, by release asset name. */
  signatures: Record<string, string>;
}

/**
 * The Tauri updater manifest (`latest.json`). Both macOS architectures take the universal
 * archive; Windows takes the NSIS setup. A platform whose signature is missing is left out, so
 * an update is never offered without a signature to verify.
 */
export function updaterManifest(i: ManifestInput) {
  const url = (name: string) => `https://github.com/${i.repo}/releases/download/${i.tag}/${name}`;
  const mac = `Clew_${i.version}_universal.app.tar.gz`;
  const win = `Clew_${i.version}_x64.exe`;
  const platforms: Record<string, { signature: string; url: string }> = {};
  const macSig = i.signatures[`${mac}.sig`];
  if (macSig) {
    for (const p of ["darwin-aarch64", "darwin-x86_64"]) {
      platforms[p] = { signature: macSig.trim(), url: url(mac) };
    }
  }
  const winSig = i.signatures[`${win}.sig`];
  if (winSig) platforms["windows-x86_64"] = { signature: winSig.trim(), url: url(win) };
  if (Object.keys(platforms).length === 0) {
    throw new ReleaseError("no update signatures found: was TAURI_SIGNING_PRIVATE_KEY set?");
  }
  return { version: i.version, notes: i.notes, pub_date: i.date, platforms };
}

/** What the release page says when the macOS or Windows installers are not signed. */
export function unsignedNote(opts: { macos: boolean; windows: boolean }): string {
  const parts: string[] = [];
  if (!opts.macos) {
    parts.push(
      "**macOS:** this build is not signed or notarized. macOS will refuse to open it at first: right-click Clew in Applications and choose Open, or run `xattr -dr com.apple.quarantine /Applications/Clew.app` once. Installing with Homebrew does this for you.",
    );
  }
  if (!opts.windows) {
    parts.push(
      "**Windows:** this build is not signed. SmartScreen will warn: choose More info, then Run anyway.",
    );
  }
  return parts.length === 0
    ? ""
    : `> ⚠️ **Unsigned build**\n>\n${parts.map((p) => `> ${p}`).join("\n>\n")}\n`;
}
