// Shared code for `pnpm icons` (scripts/build-icons.ts) and the icon checks
// (scripts/check-icons.ts). Everything is derived from the SVG sources in design/icons/.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import { format, resolveConfig } from "prettier";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SOURCE_DIR = join(ROOT, "design", "icons");
export const ICON_DIR = join(ROOT, "src-tauri", "icons");
export const MARK_COMPONENT = join(ROOT, "src", "components", "ClewMark.tsx");
export const GOLDEN_DIR = join(SOURCE_DIR, "golden");

/** Below this pixel size the small artwork is used instead of the platform master. */
export const SMALL_BELOW = 48;

export const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
export const ICNS_TYPES: Record<number, string> = {
  16: "icp4",
  32: "icp5",
  64: "icp6",
  128: "ic07",
  256: "ic08",
  512: "ic09",
  1024: "ic10",
};
export const ICNS_SIZES = Object.keys(ICNS_TYPES).map(Number);
export const GOLDEN_SIZES = [16, 32, 64, 256, 1024];

export const STORE_LOGOS: Array<[string, number]> = [
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
];

export interface Sources {
  mac: string;
  win: string;
  small: string;
  mark: string;
}

export const SOURCE_FILES: Record<keyof Sources, string> = {
  mac: "clew-icon.svg",
  win: "clew-icon-windows.svg",
  small: "clew-icon-small.svg",
  mark: "clew-mark.svg",
};

export function loadSources(dir = SOURCE_DIR): Sources {
  const read = (name: string) => readFileSync(join(dir, name), "utf8");
  return {
    mac: read(SOURCE_FILES.mac),
    win: read(SOURCE_FILES.win),
    small: read(SOURCE_FILES.small),
    mark: read(SOURCE_FILES.mark),
  };
}

// ---------------------------------------------------------------------------------------------
// Palette and contrast

export const GROUND = ["#1B2028", "#0F1217", "#14171C"];
export const GOLD = ["#F2C070", "#E3A64F", "#C58633"];
export const PALETTE = [...GROUND, ...GOLD, "#FFFFFF", "#000000"];
export const STRAND_COLOUR = "#14171C";
export const THREAD_COLOUR = "#E3A64F";
export const DEV_BLUE = "#7FC8F8";
export const MIN_CONTRAST = 7;

function expandHex(hex: string): string {
  const h = hex.toUpperCase();
  return h.length === 4 ? `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}` : h;
}

export function luminance(hex: string): number {
  const h = expandHex(hex);
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Every `#rgb`/`#rrggbb` literal in an SVG, upper-cased and expanded. */
export function coloursIn(svg: string): string[] {
  return [
    ...new Set([...svg.matchAll(/#[0-9a-fA-F]{3,6}(?![0-9a-zA-Z])/g)].map((m) => expandHex(m[0]))),
  ];
}

/** Problems with the sources; an empty list means they are valid. */
export function checkSources(src: Sources): string[] {
  const problems: string[] = [];
  for (const key of Object.keys(SOURCE_FILES) as Array<keyof Sources>) {
    const name = SOURCE_FILES[key];
    try {
      new Resvg(src[key]);
    } catch (e) {
      problems.push(`${name}: not valid SVG (${(e as Error).message})`);
      continue;
    }
    if (key !== "mark" && !/viewBox="0 0 1024 1024"/.test(src[key])) {
      problems.push(`${name}: viewBox must be 0 0 1024 1024`);
    }
    for (const colour of coloursIn(src[key])) {
      if (!PALETTE.includes(colour))
        problems.push(`${name}: colour ${colour} is not on the icon palette`);
    }
  }
  const ratio = contrast(THREAD_COLOUR, STRAND_COLOUR);
  if (ratio < MIN_CONTRAST) {
    problems.push(`gold/strand contrast ${ratio.toFixed(2)}:1 is below ${MIN_CONTRAST}:1`);
  }
  return problems;
}

// ---------------------------------------------------------------------------------------------
// Rendering

export type Platform = "mac" | "win";

export function renderSvg(svg: string, size: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  });
  return Buffer.from(resvg.render().asPng());
}

/** The artwork a pixel size is rendered from (never scaled from a different size). */
export function artworkFor(src: Sources, platform: Platform, size: number): string {
  if (size < SMALL_BELOW) return src.small;
  return platform === "mac" ? src.mac : src.win;
}

export function renderIcon(src: Sources, platform: Platform, size: number, dev = false): Buffer {
  let svg = artworkFor(src, platform, size);
  if (dev) svg = withDevBadge(svg, size < SMALL_BELOW);
  return renderSvg(svg, size);
}

// ---------------------------------------------------------------------------------------------
// Development badge: a blue "DEV" pill at the lower left of the body. Letters are paths so that
// rendering never depends on fonts.

const DEV_PILL = `<g id="dev-badge"><rect x="215" y="760" width="250" height="96" rx="48" fill="${DEV_BLUE}"/><g fill="none" stroke="#0F1217" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"><path d="M270 782 H280 C296 782 302 794 302 808 C302 822 296 834 280 834 H270 Z"/><path d="M350 782 H326 V834 H350 M326 808 H346"/><path d="M372 782 L394 834 L416 782"/></g></g>`;
// Small artwork has a near full-bleed body and its thread sits at the lower right; a plain pill
// (no letters, unreadable at those sizes anyway) goes lower left.
const DEV_PILL_SMALL = `<rect id="dev-badge" x="56" y="820" width="280" height="140" rx="70" fill="${DEV_BLUE}"/>`;

export function withDevBadge(svg: string, small: boolean): string {
  return svg.replace("</svg>", `${small ? DEV_PILL_SMALL : DEV_PILL}</svg>`);
}

// ---------------------------------------------------------------------------------------------
// Containers

export function writeIco(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  const header = Buffer.alloc(6 + 16 * sorted.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sorted.length, 4);
  let offset = header.length;
  sorted.forEach((e, i) => {
    const at = 6 + 16 * i;
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at);
    header.writeUInt8(e.size >= 256 ? 0 : e.size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(e.png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += e.png.length;
  });
  return Buffer.concat([header, ...sorted.map((e) => e.png)]);
}

export function parseIco(buf: Buffer): number[] {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error("not an ICO file");
  const count = buf.readUInt16LE(4);
  return Array.from({ length: count }, (_, i) => buf.readUInt8(6 + 16 * i) || 256);
}

export function writeIcns(entries: Array<{ size: number; png: Buffer }>): Buffer {
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  const parts = sorted.map((e) => {
    const type = ICNS_TYPES[e.size];
    if (!type) throw new Error(`no ICNS type for ${e.size}px`);
    const head = Buffer.alloc(8);
    head.write(type, 0, "ascii");
    head.writeUInt32BE(8 + e.png.length, 4);
    return Buffer.concat([head, e.png]);
  });
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write("icns", 0, "ascii");
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

export function parseIcns(buf: Buffer): number[] {
  if (buf.toString("ascii", 0, 4) !== "icns") throw new Error("not an ICNS file");
  const bySize = Object.fromEntries(Object.entries(ICNS_TYPES).map(([s, t]) => [t, Number(s)]));
  const sizes: number[] = [];
  let at = 8;
  while (at < buf.length) {
    const type = buf.toString("ascii", at, at + 4);
    const len = buf.readUInt32BE(at + 4);
    if (bySize[type] !== undefined) sizes.push(bySize[type]);
    at += len;
  }
  return sizes;
}

export function pngSize(png: Buffer): number {
  return png.readUInt32BE(16);
}

export function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------------------------------------------------------------------------------------------
// ClewMark component, generated from clew-mark.svg

function jsxAttrs(xml: string): string {
  // Mask luminance values, not theme colours: keep literal hex out of src/.
  xml = xml.replace(/"#fff"/g, '"white"').replace(/"#000"/g, '"black"');
  return xml.replace(/ ([a-z]+(?:-[a-z]+)+)=/g, (_m, name: string) => {
    const camel = name.replace(/-([a-z])/g, (_x, c: string) => c.toUpperCase());
    return ` ${camel}=`;
  });
}

export async function markComponent(markSvg: string): Promise<string> {
  const mask = /<mask [^>]*>([\s\S]*?)<\/mask>/.exec(markSvg);
  const rest = /<\/defs>\s*([\s\S]*?)\s*<\/svg>/.exec(markSvg);
  if (!mask || !rest)
    throw new Error("clew-mark.svg: expected one <mask> and shapes after </defs>");
  const clean = (s: string) =>
    jsxAttrs(s).replace(/ mask="url\(#[^)]+\)"/g, " mask={`url(#${maskId})`}");
  const code = `// Generated by scripts/build-icons.ts from design/icons/clew-mark.svg. Do not edit.
import { useId } from "react";

export interface ClewMarkProps {
  /** Pixel size; the mark is square. */
  size?: number;
  /** Accessible name. */
  title?: string;
  className?: string;
}

/** The Clew mark: one colour (currentColor) with the strands cut out of the ball. */
export function ClewMark({ size = 24, title = "Clew", className }: ClewMarkProps) {
  const maskId = \`clew-mark-cut-\${useId().replace(/:/g, "")}\`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      role="img"
      aria-label={title}
      className={className}
    >
      <defs>
        <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          ${clean(mask[1]).trim()}
        </mask>
      </defs>
      ${clean(rest[1])}
    </svg>
  );
}
`;
  const options = (await resolveConfig(join(ROOT, "src", "components", "ClewMark.tsx"))) ?? {};
  return format(code, { ...options, parser: "typescript" });
}

// ---------------------------------------------------------------------------------------------
// Full asset set

/** Relative path (under src-tauri/icons/, or src/ for the component) -> file contents. */
export type Assets = Map<string, Buffer | string>;

function iconSet(src: Sources, dev: boolean): Assets {
  const out: Assets = new Map();
  const prefix = dev ? "dev/" : "";
  const win = (size: number) => renderIcon(src, "win", size, dev);
  out.set(`${prefix}32x32.png`, win(32));
  out.set(`${prefix}128x128.png`, win(128));
  out.set(`${prefix}128x128@2x.png`, win(256));
  out.set(`${prefix}icon.png`, win(512));
  for (const [name, size] of STORE_LOGOS) out.set(`${prefix}${name}`, win(size));
  out.set(`${prefix}icon.ico`, writeIco(ICO_SIZES.map((size) => ({ size, png: win(size) }))));
  out.set(
    `${prefix}icon.icns`,
    writeIcns(ICNS_SIZES.map((size) => ({ size, png: renderIcon(src, "mac", size, dev) }))),
  );
  return out;
}

/** Everything `pnpm icons` writes: release set, dev set (icons/dev/) and the ClewMark component. */
export async function generateAssets(src: Sources): Promise<{ icons: Assets; mark: string }> {
  const icons: Assets = new Map([...iconSet(src, false), ...iconSet(src, true)]);
  return { icons, mark: await markComponent(src.mark) };
}

/** Golden renders: the macOS pipeline at each golden size. */
export function renderGolden(src: Sources): Map<number, Buffer> {
  return new Map(GOLDEN_SIZES.map((size) => [size, renderIcon(src, "mac", size)]));
}
