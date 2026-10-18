// Command line of the release pipeline, called by .github/workflows/release.yml.
//   tsx scripts/release/cli.ts meta <tag>|--from-files|--from-files             version/tag/prerelease as KEY=value lines
//   tsx scripts/release/cli.ts collect <version> <out-dir>         copy the bundler output under its release names
//   tsx scripts/release/cli.ts unsigned-note <macos-signed> <windows-signed>
//   tsx scripts/release/cli.ts finish <dir> <repo> <tag> <version> write SHA256SUMS.txt and latest.json for the files in <dir>
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  ReleaseError,
  cargoVersion,
  checkTag,
  checksumLines,
  releaseAssets,
  unsignedNote,
  updaterManifest,
} from "./lib";

const root = resolve(".");
const read = (p: string) => readFileSync(join(root, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const n of names) {
    const p = join(dir, n);
    const s = statSync(p);
    if (s.isDirectory()) {
      // The .app bundle is a directory; its files are not release assets.
      if (!n.endsWith(".app")) walk(p, out);
    } else out.push(p);
  }
  return out;
}

function main(argv: string[]): number {
  const [cmd, ...args] = argv;
  try {
    if (cmd === "meta") {
      const versions = {
        "package.json": (JSON.parse(read("package.json")) as { version: string }).version,
        "src-tauri/tauri.conf.json": (
          JSON.parse(read("src-tauri/tauri.conf.json")) as { version: string }
        ).version,
        "src-tauri/Cargo.toml": cargoVersion(read("src-tauri/Cargo.toml")),
      };
      // A dry run has no tag: build what the files say.
      const tag = args[0] === "--from-files" ? `v${versions["package.json"]}` : (args[0] ?? "");
      const meta = checkTag(tag, versions);
      console.log(`version=${meta.version}\ntag=${meta.tag}\nprerelease=${meta.prerelease}`);
      return 0;
    }
    if (cmd === "collect") {
      const [version, out] = args;
      mkdirSync(out, { recursive: true });
      const files = walk(join(root, "src-tauri", "target")).filter((f) =>
        /[\\/]bundle[\\/]/.test(f),
      );
      const assets = releaseAssets(version, files);
      if (assets.length === 0) throw new ReleaseError("the build produced no installers");
      for (const a of assets) {
        copyFileSync(a.from, join(out, a.name));
        console.log(`${a.from} -> ${a.name}`);
      }
      return 0;
    }
    if (cmd === "finish") {
      const [dir, repo, tag, version] = args;
      const files = readdirSync(dir).filter((f) => f !== "SHA256SUMS.txt" && f !== "latest.json");
      const entries = files.map((name) => ({ name, data: readFileSync(join(dir, name)) }));
      // Checksums cover the installers and updater archives, not the signature files.
      writeFileSync(
        join(dir, "SHA256SUMS.txt"),
        checksumLines(entries.filter((e) => !e.name.endsWith(".sig"))),
      );
      const signatures = Object.fromEntries(
        entries
          .filter((e) => e.name.endsWith(".sig"))
          .map((e) => [e.name, e.data.toString("utf8")]),
      );
      const notes = process.env.RELEASE_NOTES ?? "";
      writeFileSync(
        join(dir, "latest.json"),
        JSON.stringify(
          updaterManifest({
            version,
            notes,
            date: new Date().toISOString(),
            repo,
            tag,
            signatures,
          }),
          null,
          2,
        ) + "\n",
      );
      console.log("wrote SHA256SUMS.txt and latest.json");
      return 0;
    }
    if (cmd === "unsigned-note") {
      // The text at the top of the release page when an installer is not signed.
      process.stdout.write(
        unsignedNote({ macos: args[0] === "true", windows: args[1] === "true" }),
      );
      return 0;
    }
    console.error("usage: cli.ts meta|collect|finish|unsigned-note ...");
    return 2;
  } catch (e) {
    if (e instanceof ReleaseError) {
      console.error(`error: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

process.exit(main(process.argv.slice(2)));
