// `pnpm check:icons`: sources valid, generated files up to date, no default Tauri art, ICO/ICNS
// contents, golden images. Runs in the PR workflow.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pixelmatch from "pixelmatch";
import { PNG } from "pngjs";
import {
  GOLDEN_DIR,
  GOLDEN_SIZES,
  ICNS_SIZES,
  ICON_DIR,
  ICO_SIZES,
  MARK_COMPONENT,
  ROOT,
  checkSources,
  generateAssets,
  loadSources,
  parseIcns,
  parseIco,
  renderGolden,
  sha256,
  type Sources,
} from "./icons-lib";

/** Fraction of pixels allowed to differ from a golden image. */
export const GOLDEN_TOLERANCE = 0.001;

const normalise = (b: Buffer | string) =>
  typeof b === "string" ? Buffer.from(b.replace(/\r\n/g, "\n")) : b;

export async function checkUpToDate(src: Sources): Promise<string[]> {
  const problems: string[] = [];
  const { icons, mark } = await generateAssets(src);
  const stale = (path: string, expected: Buffer | string) => {
    if (!existsSync(path) || !normalise(readFileSync(path)).equals(normalise(expected))) {
      problems.push(`${path.replace(ROOT + "/", "")} is stale: run \`pnpm icons\``);
    }
  };
  for (const [name, data] of icons) stale(join(ICON_DIR, name), data);
  stale(MARK_COMPONENT, mark);
  return problems;
}

export function checkNoDefaultArt(iconDir = ICON_DIR, hashFile?: string): string[] {
  const list = readFileSync(
    hashFile ?? join(ROOT, "scripts", "tauri-default-icon-hashes.txt"),
    "utf8",
  );
  const defaults = new Set(
    list
      .split("\n")
      .map((l) => l.split(/\s+/)[0])
      .filter(Boolean),
  );
  const problems: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (defaults.has(sha256(readFileSync(path)))) {
        problems.push(`${path.replace(ROOT + "/", "")} is a default Tauri icon`);
      }
    }
  };
  walk(iconDir);
  return problems;
}

const sameList = (a: number[], b: number[]) =>
  a.length === b.length &&
  [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);

export function checkContainers(iconDir = ICON_DIR): string[] {
  const problems: string[] = [];
  for (const dir of [iconDir, join(iconDir, "dev")]) {
    const ico = parseIco(readFileSync(join(dir, "icon.ico")));
    if (!sameList(ico, ICO_SIZES)) problems.push(`${dir}/icon.ico has sizes ${ico.join(",")}`);
    const icns = parseIcns(readFileSync(join(dir, "icon.icns")));
    if (!sameList(icns, ICNS_SIZES)) problems.push(`${dir}/icon.icns has sizes ${icns.join(",")}`);
  }
  return problems;
}

/** Compare renders with the approved goldens; diff images go to `diffDir`. */
export function checkGolden(
  src: Sources,
  goldenDir = GOLDEN_DIR,
  diffDir = join(ROOT, "dist", "icon-diff"),
): string[] {
  const problems: string[] = [];
  for (const [size, png] of renderGolden(src)) {
    const file = join(goldenDir, `${size}.png`);
    if (!existsSync(file)) {
      problems.push(`golden ${size}.png missing: run \`pnpm icons --update-golden\``);
      continue;
    }
    const actual = PNG.sync.read(png);
    const golden = PNG.sync.read(readFileSync(file));
    const diff = new PNG({ width: actual.width, height: actual.height });
    const count = pixelmatch(actual.data, golden.data, diff.data, actual.width, actual.height, {
      threshold: 0.1,
      includeAA: true,
    });
    const share = count / (actual.width * actual.height);
    if (share > GOLDEN_TOLERANCE) {
      mkdirSync(diffDir, { recursive: true });
      writeFileSync(join(diffDir, `${size}.png`), PNG.sync.write(diff));
      problems.push(
        `golden ${size}.png differs in ${(share * 100).toFixed(2)}% of pixels (diff: ${join(diffDir, `${size}.png`)})`,
      );
    }
  }
  return problems;
}

export { GOLDEN_SIZES };

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  const src = loadSources();
  const problems = [
    ...checkSources(src),
    ...(await checkUpToDate(src)),
    ...checkNoDefaultArt(),
    ...checkContainers(),
    ...checkGolden(src),
  ];
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("icons ok");
}
