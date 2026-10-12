// Token lint (spec: design-conformance › Token conformance): no colour literals (hex, rgb, hsl)
// and no font-family other than the font tokens outside src/styles/tokens.css. Runs in PR CI.
// Usage: pnpm check:tokens
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

export interface Violation {
  file: string;
  line: number;
  text: string;
  problem: string;
}

const COLOUR = /#[0-9a-fA-F]{3,8}\b(?![\w-])|\b(?:rgba?|hsla?)\(/;
const FONT_FAMILY = /font-family\s*:\s*(?!\s)(?!var\(--font-[\w-]+\)[;}\s]*$)/;

/** Replace comments with spaces so line numbers stay put. */
function stripComments(text: string, css: boolean): string {
  const block = (m: string) => m.replace(/[^\n]/g, " ");
  let out = text.replace(/\/\*[\s\S]*?\*\//g, block);
  if (!css)
    out = out.replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p) => p + " ".repeat(m.length - p.length));
  return out;
}

export function lintSource(file: string, text: string): Violation[] {
  const css = file.endsWith(".css");
  const out: Violation[] = [];
  stripComments(text, css)
    .split("\n")
    .forEach((line, i) => {
      if (COLOUR.test(line)) {
        out.push({
          file,
          line: i + 1,
          text: line.trim(),
          problem: "colour literal; use a token from tokens.css",
        });
      }
      if (FONT_FAMILY.test(line)) {
        out.push({
          file,
          line: i + 1,
          text: line.trim(),
          problem: "font family; use var(--font-ui) or var(--font-mono)",
        });
      }
    });
  return out;
}

const SKIP_DIRS = new Set(["node_modules", "generated", "dist"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(css|tsx?)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function main(): number {
  const root = resolve(".");
  const violations: Violation[] = [];
  for (const f of walk(join(root, "src"))) {
    const rel = relative(root, f);
    if (rel === join("src", "styles", "tokens.css")) continue;
    violations.push(...lintSource(rel, readFileSync(f, "utf8")));
  }
  for (const v of violations) console.error(`FAIL ${v.file}:${v.line}: ${v.problem}: ${v.text}`);
  if (violations.length === 0)
    console.log("ok: no colour literals or font families outside tokens.css");
  return violations.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
