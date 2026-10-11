// @vitest-environment node
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { checkContainers, checkGolden, checkNoDefaultArt, checkUpToDate } from "./check-icons";
import {
  ICNS_SIZES,
  ICON_DIR,
  ICO_SIZES,
  MIN_CONTRAST,
  STRAND_COLOUR,
  THREAD_COLOUR,
  artworkFor,
  checkSources,
  contrast,
  generateAssets,
  loadSources,
  parseIcns,
  parseIco,
  pngSize,
  renderIcon,
  sha256,
  type Sources,
} from "./icons-lib";

const src = loadSources();

describe("icon sources", () => {
  it("are valid, on palette and contrast-safe", () => {
    expect(checkSources(src)).toEqual([]);
    expect(contrast(THREAD_COLOUR, STRAND_COLOUR)).toBeGreaterThanOrEqual(MIN_CONTRAST);
  });

  it("fail on an off-palette colour", () => {
    const bad: Sources = { ...src, mac: src.mac.replace("#E3A64F", "#FF00AA") };
    expect(checkSources(bad).join("\n")).toMatch(/clew-icon\.svg: colour #FF00AA/);
  });

  it("fail on a wrong viewBox and on invalid SVG", () => {
    const wrongBox: Sources = {
      ...src,
      win: src.win.replace('viewBox="0 0 1024 1024"', 'viewBox="0 0 512 512"'),
    };
    expect(checkSources(wrongBox).join("\n")).toMatch(/viewBox/);
    expect(checkSources({ ...src, small: "<svg" }).join("\n")).toMatch(/not valid SVG/);
  });
});

describe("generation", () => {
  it("is byte-identical when run twice", async () => {
    const a = await generateAssets(src);
    const b = await generateAssets(src);
    expect(a.mark).toBe(b.mark);
    expect([...a.icons.keys()]).toEqual([...b.icons.keys()]);
    for (const [name, data] of a.icons)
      expect(sha256(data as Buffer), name).toBe(sha256(b.icons.get(name) as Buffer));
  });

  it("matches the committed files", async () => {
    expect(await checkUpToDate(src)).toEqual([]);
  });

  it("lists exactly the required ICO and ICNS sizes", () => {
    expect(parseIco(readFileSync(join(ICON_DIR, "icon.ico")))).toEqual(ICO_SIZES);
    expect(parseIcns(readFileSync(join(ICON_DIR, "icon.icns")))).toEqual(ICNS_SIZES);
    expect(checkContainers()).toEqual([]);
  });

  it("renders below 48 px from the small artwork and 48+ from the master", () => {
    expect(artworkFor(src, "mac", 16)).toBe(src.small);
    expect(artworkFor(src, "win", 47)).toBe(src.small);
    expect(artworkFor(src, "mac", 64)).toBe(src.mac);
    expect(artworkFor(src, "win", 64)).toBe(src.win);
    const png = renderIcon(src, "mac", 16);
    expect(pngSize(png)).toBe(16);
    expect(png.equals(renderIcon({ ...src, mac: "", win: "" }, "mac", 16))).toBe(true);
  });

  it("keeps the DEV badge out of the release set", () => {
    const release = readFileSync(join(ICON_DIR, "icon.png"));
    const dev = readFileSync(join(ICON_DIR, "dev", "icon.png"));
    expect(release.equals(dev)).toBe(false);
    expect(existsSync(join(ICON_DIR, "dev", "icon.ico"))).toBe(true);
  });
});

describe("default Tauri art", () => {
  it("is absent", () => {
    expect(checkNoDefaultArt()).toEqual([]);
  });

  it("is reported by name", () => {
    const dir = mkdtempSync(join(tmpdir(), "icons-"));
    cpSync(join(ICON_DIR, "icon.png"), join(dir, "icon.png"));
    const hashes = join(dir, "hashes.txt");
    const sum = sha256(readFileSync(join(dir, "icon.png")));
    cpSync(join(ICON_DIR, "icon.png"), join(dir, "other.png"));
    // A default-hash list that contains our own file stands in for a restored default icon.
    writeFileSync(hashes, `${sum}  icon.png\n`);
    expect(checkNoDefaultArt(dir, hashes).join("\n")).toMatch(/icon\.png is a default Tauri icon/);
  });
});

describe("golden images", () => {
  it("match", () => {
    expect(checkGolden(src)).toEqual([]);
  });

  it("fail when the thread shifts by 6 px", () => {
    const diffDir = mkdtempSync(join(tmpdir(), "icon-diff-"));
    const shifted: Sources = {
      ...src,
      mac: src.mac.replace('<path d="M452 699', '<path transform="translate(6 0)" d="M452 699'),
    };
    expect(shifted.mac).not.toBe(src.mac);
    const problems = checkGolden(shifted, undefined, diffDir);
    expect(problems.join("\n")).toMatch(/golden 256\.png/);
    expect(problems.join("\n")).toMatch(/golden 1024\.png/);
    const diff = PNG.sync.read(readFileSync(join(diffDir, "1024.png")));
    expect(diff.width).toBe(1024);
  });
});
