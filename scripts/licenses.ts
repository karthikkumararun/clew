// Generate src-tauri/resources/THIRD_PARTY_LICENSES.html (spec: release-packaging › Open-source
// project files) and fail when a shipped dependency has a license outside the allow-list.
// Rust: `cargo about`. npm: the packages Vite actually bundles, read from a real build, with
// their licenses from `pnpm licenses`.
//   tsx scripts/licenses.ts [--check] [--npm-only]
//     --check verifies the allow-list and writes nothing; --npm-only skips the Rust crates (CI
//     checks those with `cargo deny check licenses`, which is quicker).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "vite";
import { disallowed, packageOfModule, renderLicensesHtml } from "./licenses-lib";
import type { Entry } from "./licenses-lib";

const root = resolve(".");

interface AboutJson {
  licenses: {
    id: string;
    text: string;
    used_by: { crate: { name: string; version: string; repository?: string } }[];
  }[];
}

function rustEntries(): Entry[] {
  const out = resolve(root, "src-tauri", "target", "licenses-rust.json");
  execFileSync("cargo", ["about", "generate", "--format", "json", "-c", "about.toml", "-o", out], {
    cwd: join(root, "src-tauri"),
    stdio: ["ignore", "inherit", "inherit"],
  });
  const data = JSON.parse(readFileSync(out, "utf8")) as AboutJson;
  return data.licenses.flatMap((l) =>
    l.used_by.map((u) => ({
      name: u.crate.name,
      version: u.crate.version,
      license: l.id,
      text: l.text,
      homepage: u.crate.repository,
    })),
  );
}

/** Names of the npm packages that end up in the production bundle. */
async function bundledPackages(): Promise<Map<string, string>> {
  const found = new Map<string, string>(); // name → package directory
  await build({
    logLevel: "silent",
    configFile: join(root, "vite.config.ts"),
    build: { write: false, outDir: join(root, "target-licenses") },
    plugins: [
      {
        name: "collect-modules",
        generateBundle(_o, bundle) {
          for (const chunk of Object.values(bundle)) {
            if (chunk.type !== "chunk") continue;
            for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
              const p = packageOfModule(id);
              if (p && !found.has(p.name)) found.set(p.name, p.dir);
            }
          }
        },
      },
    ],
  });
  return found;
}

function licenseText(dir: string): string {
  const files = existsSync(dir) ? readdirSync(dir) : [];
  const file = files.find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
  return file ? readFileSync(join(dir, file), "utf8") : "";
}

async function npmEntries(): Promise<Entry[]> {
  const bundled = await bundledPackages();
  const listed = JSON.parse(
    execFileSync("pnpm", ["licenses", "list", "--json"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: process.platform === "win32",
    }),
  ) as Record<string, { name: string; versions: string[]; paths: string[]; homepage?: string }[]>;
  const entries: Entry[] = [];
  for (const [license, pkgs] of Object.entries(listed)) {
    for (const p of pkgs) {
      if (!bundled.has(p.name)) continue; // a build tool or test library: not shipped
      const dir = bundled.get(p.name) as string;
      const own =
        p.paths.find((x) => x.replace(/\\/g, "/").endsWith(`node_modules/${p.name}`)) ?? dir;
      entries.push({
        name: p.name,
        version: p.versions.join(", "),
        license,
        text: licenseText(own) || licenseText(dir) || `${license} (see ${p.homepage ?? p.name})`,
        homepage: p.homepage,
      });
    }
  }
  return entries;
}

async function main(): Promise<number> {
  const check = process.argv.includes("--check");
  const npmOnly = process.argv.includes("--npm-only");
  const entries = [...(await npmEntries()), ...(npmOnly ? [] : rustEntries())];
  const bad = disallowed(entries);
  if (bad.length > 0) {
    console.error("These dependencies have a license outside the allow-list:");
    for (const e of bad) console.error(`  ${e.name} ${e.version}: ${e.license}`);
    console.error("Allowed: see ALLOWED in scripts/licenses-lib.ts and src-tauri/deny.toml.");
    return 1;
  }
  if (check) {
    console.log(`ok: ${entries.length} shipped dependencies, all licenses allowed`);
    return 0;
  }
  const html = renderLicensesHtml(readFileSync(join(root, "LICENSE"), "utf8"), entries);
  writeFileSync(join(root, "src-tauri", "resources", "THIRD_PARTY_LICENSES.html"), html);
  console.log(
    `wrote src-tauri/resources/THIRD_PARTY_LICENSES.html (${entries.length} dependencies)`,
  );
  return 0;
}

process.exit(await main());
