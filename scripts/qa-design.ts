// `pnpm qa:design`: capture every design state (the `design` e2e suite), then write the
// side-by-side review report e2e/artifacts/design/index.html (spec: design-conformance ›
// Side-by-side design review). `--update` stores the captured screenshots as this platform's
// approved baselines (e2e/baselines/<platform>/), `--no-run` only rebuilds the report.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { compare, decode, encode, passes, type Mask } from "./design-lib";

interface Captured {
  id: string;
  screen: string;
  description: string;
  problems: string[];
  overlayIssues: string[];
  masks: Mask[];
}

interface Row extends Captured {
  reference: boolean;
  baseline: boolean;
  /** Ratio of pixels differing from the baseline, when there is one. */
  baselineRatio?: number;
  /** Ratio of pixels differing from the canvas reference, when sizes allow it. */
  referenceRatio?: number;
  failed: boolean;
}

const OUT = resolve("e2e", "artifacts", "design");
const platform =
  process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux";
const BASELINES = resolve("e2e", "baselines", platform);

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

function buildRows(): Row[] {
  const rows: Row[] = [];
  for (const f of readdirSync(OUT).filter((f) => f.endsWith(".json") && f !== "verdicts.json")) {
    const c = JSON.parse(readFileSync(join(OUT, f), "utf8")) as Captured;
    const shot = decode(readFileSync(join(OUT, `${c.id}.png`)));
    const refFile = resolve("design", "screens", `${c.screen}.png`);
    const baseFile = join(BASELINES, `${c.id}.png`);
    const row: Row = {
      ...c,
      reference: existsSync(refFile),
      baseline: existsSync(baseFile),
      failed: false,
    };
    if (row.baseline) {
      const cmp = compare(shot, decode(readFileSync(baseFile)), c.masks);
      row.baselineRatio = cmp.ratio;
      if (cmp.diff) writeFileSync(join(OUT, `${c.id}.diff.png`), encode(cmp.diff));
      if (!passes(cmp)) row.failed = true;
    }
    if (row.reference) {
      const cmp = compare(shot, decode(readFileSync(refFile)), c.masks);
      row.referenceRatio = cmp.comparable ? cmp.ratio : undefined;
      if (cmp.diff) writeFileSync(join(OUT, `${c.id}.overlay.png`), encode(cmp.diff));
      if (existsSync(refFile)) copyFileSync(refFile, join(OUT, `${c.id}.reference.png`));
    }
    if (c.problems.length > 0 || c.overlayIssues.length > 0) row.failed = true;
    rows.push(row);
  }
  // states whose metrics or baseline failed come first
  return rows.sort((a, b) => Number(b.failed) - Number(a.failed) || a.id.localeCompare(b.id));
}

function img(src: string, label: string, present: boolean): string {
  return present
    ? `<figure><figcaption>${label}</figcaption><img src="${src}" alt="${label}"></figure>`
    : `<figure><figcaption>${label}</figcaption><p class="none">none yet</p></figure>`;
}

export function renderHtml(rows: Row[]): string {
  const body = rows
    .map(
      (r) => `<section class="${r.failed ? "failed" : ""}" id="${r.id}">
  <h2>${esc(r.screen)} › ${esc(r.id)} ${r.failed ? "<mark>needs attention</mark>" : ""}</h2>
  <p>${esc(r.description)}</p>
  ${r.problems
    .concat(r.overlayIssues)
    .map((p) => `<p class="problem">${esc(p)}</p>`)
    .join("")}
  <div class="row">
    ${img(`${r.id}.reference.png`, "Canvas reference", r.reference)}
    ${img(`${r.id}.png`, "App", true)}
    ${img(`${r.id}.overlay.png`, `Overlay vs canvas${r.referenceRatio !== undefined ? ` (${(r.referenceRatio * 100).toFixed(2)}% differ)` : ""}`, r.reference && r.referenceRatio !== undefined)}
    ${img(`${r.id}.diff.png`, `Diff vs baseline${r.baselineRatio !== undefined ? ` (${(r.baselineRatio * 100).toFixed(3)}% differ)` : ""}`, r.baseline)}
  </div>
  <label>Verdict <select data-state="${r.id}"><option value="">undecided</option><option>approved</option><option>discrepancy</option></select></label>
</section>`,
    )
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>Design review</title>
<style>
body{font:14px system-ui;margin:24px;background:#111;color:#ddd}section{border-top:1px solid #333;padding:16px 0}
.failed h2{color:#f2766b}mark{background:#3a1d1b;color:#f7a39b;padding:2px 6px;border-radius:4px;font-size:12px}
.row{display:flex;gap:12px;flex-wrap:wrap}figure{margin:0;flex:1 1 320px}figure img{width:100%;border:1px solid #333}
.problem{color:#f7a39b;font-family:monospace}.none{color:#777}
</style>
<h1>Design review</h1><p>${rows.length} states, ${rows.filter((r) => r.failed).length} needing attention (listed first).</p>
${body}
<button id="copy">Copy verdicts as JSON</button>
<script>
const key='clew-design-verdicts';const saved=JSON.parse(localStorage.getItem(key)||'{}');
document.querySelectorAll('select[data-state]').forEach(s=>{s.value=saved[s.dataset.state]||'';s.onchange=()=>{saved[s.dataset.state]=s.value;localStorage.setItem(key,JSON.stringify(saved))}});
document.getElementById('copy').onclick=()=>navigator.clipboard.writeText(JSON.stringify(saved,null,2));
</script>`;
}

function main(): number {
  const args = process.argv.slice(2);
  if (!args.includes("--no-run")) {
    const run = spawnSync("pnpm", ["qa:e2e", "--suite", "design"], {
      stdio: "inherit",
      shell: process.platform === "win32",
    });
    if (run.status !== 0)
      console.error("the design suite failed; the report still shows what was captured");
  }
  if (!existsSync(OUT)) {
    console.error("no captured states: run the design suite first");
    return 1;
  }
  if (args.includes("--update")) {
    mkdirSync(BASELINES, { recursive: true });
    for (const f of readdirSync(OUT).filter(
      (f) => /^[\w-]+\.png$/.test(f) && !/\.(diff|overlay|reference)\.png$/.test(f),
    )) {
      copyFileSync(join(OUT, f), join(BASELINES, f));
    }
    console.log(
      `baselines updated in ${BASELINES}: review the images and commit them with the reason`,
    );
  }
  const rows = buildRows();
  writeFileSync(join(OUT, "index.html"), renderHtml(rows));
  const failed = rows.filter((r) => r.failed);
  for (const r of failed) {
    console.error(
      `FAIL ${r.id}: ${[...r.problems, ...r.overlayIssues].join("; ") || `${((r.baselineRatio ?? 0) * 100).toFixed(3)}% of pixels differ from the baseline (diff: ${r.id}.diff.png)`}`,
    );
  }
  console.log(
    `report: ${join("e2e", "artifacts", "design", "index.html")} (${rows.length} states, ${failed.length} failed)`,
  );
  return failed.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
