// Scenario traceability (spec: e2e-testing › Scenario traceability). Tests declare the spec
// scenarios they cover as `(spec: capability › Scenario)`; this script verifies that every
// declaration still exists in openspec/specs or an active change, and writes docs/qa/coverage.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export type Level = "unit" | "integration" | "e2e" | "design";

export interface Scenario {
  capability: string;
  requirement: string;
  name: string;
  /** The WHEN/THEN lines, without the list markers. */
  steps: string[];
  /** Marked `<!-- manual -->` in the spec: always goes on the manual checklist. */
  manual: boolean;
  /** "finished" lives in openspec/specs; "active" in an open change. */
  status: "finished" | "active";
}

export interface Declaration {
  file: string;
  line: number;
  level: Level;
  /** The reference exactly as written, e.g. "sql-console › Cancel". */
  ref: string;
}

export interface Dangling {
  declaration: Declaration;
  reason: string;
}

const SEP = "›";
const IGNORE_MARKER = "@coverage-ignore-file";

/** Read requirements and scenarios from one spec.md. */
export function parseSpec(
  text: string,
  capability: string,
  status: Scenario["status"],
): { scenarios: Scenario[]; requirements: string[] } {
  const scenarios: Scenario[] = [];
  const requirements: string[] = [];
  let requirement = "";
  let current: Scenario | undefined;
  for (const line of text.split("\n")) {
    const req = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (req) {
      requirement = req[1];
      requirements.push(requirement);
      current = undefined;
      continue;
    }
    const sc = /^####\s+Scenario:\s*(.+?)\s*$/.exec(line);
    if (sc) {
      current = { capability, requirement, name: sc[1], steps: [], manual: false, status };
      scenarios.push(current);
      continue;
    }
    if (!current) continue;
    if (/<!--\s*manual\s*-->/.test(line)) current.manual = true;
    const step = /^-\s+(.*\S)\s*$/.exec(line);
    if (step) current.steps.push(step[1].replace(/\*\*/g, ""));
  }
  return { scenarios, requirements };
}

/** Find every `(spec: a › b; c › d)` declaration in a source file. */
export function parseDeclarations(text: string, file: string, level: Level): Declaration[] {
  const out: Declaration[] = [];
  const push = (line: number, ref: string) => {
    const trimmed = ref.trim();
    if (trimmed) out.push({ file, line, level, ref: trimmed });
  };
  text.split("\n").forEach((content, i) => {
    for (const m of content.matchAll(/\(spec:\s*([^)]*)\)/g)) {
      for (const ref of m[1].split(";")) push(i + 1, ref);
    }
    // e2e helper form: covers("capability › Scenario", "capability › Other")
    for (const m of content.matchAll(/\bcovers\(([^)]*)\)/g)) {
      for (const q of m[1].matchAll(/"([^"]+)"/g)) push(i + 1, q[1]);
    }
  });
  return out;
}

export interface SpecIndex {
  scenarios: Scenario[];
  requirements: Map<string, Set<string>>;
}

export function indexSpecs(root: string): SpecIndex {
  const scenarios: Scenario[] = [];
  const requirements = new Map<string, Set<string>>();
  const add = (specFile: string, capability: string, status: Scenario["status"]) => {
    const parsed = parseSpec(readFileSync(specFile, "utf8"), capability, status);
    scenarios.push(...parsed.scenarios);
    const set = requirements.get(capability) ?? new Set<string>();
    parsed.requirements.forEach((r) => set.add(r));
    requirements.set(capability, set);
  };

  const finished = join(root, "openspec", "specs");
  if (existsSync(finished)) {
    for (const cap of readdirSync(finished)) {
      const f = join(finished, cap, "spec.md");
      if (existsSync(f)) add(f, cap, "finished");
    }
  }
  const changes = join(root, "openspec", "changes");
  if (existsSync(changes)) {
    for (const change of readdirSync(changes)) {
      if (change === "archive") continue;
      const specs = join(changes, change, "specs");
      if (!existsSync(specs)) continue;
      for (const cap of readdirSync(specs)) {
        const f = join(specs, cap, "spec.md");
        if (existsSync(f)) add(f, cap, "active");
      }
    }
  }
  return { scenarios, requirements };
}

/** A ref is `capability › Scenario` or `capability › Requirement › Scenario`. */
export function resolveRef(
  ref: string,
  index: SpecIndex,
): { scenario?: Scenario; requirement?: string; problem?: string } {
  const parts = ref.split(SEP).map((p) => p.trim());
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !p)) {
    return { problem: `"${ref}" is not "capability ${SEP} Scenario"` };
  }
  const capability = parts[0];
  const last = parts[parts.length - 1];
  const reqs = index.requirements.get(capability);
  if (!reqs) return { problem: `unknown capability "${capability}"` };
  const scenario = index.scenarios.find(
    (s) =>
      s.capability === capability &&
      s.name === last &&
      (parts.length === 2 || s.requirement === parts[1]),
  );
  if (scenario) return { scenario };
  if (parts.length === 2 && reqs.has(last)) return { requirement: last };
  if (parts.length === 3 && reqs.has(parts[1]) && !reqs.has(last)) {
    return { problem: `scenario "${last}" not found under requirement "${parts[1]}"` };
  }
  return { problem: `no scenario or requirement "${last}" in "${capability}"` };
}

export interface Coverage {
  dangling: Dangling[];
  /** key: capability + requirement + scenario name */
  byScenario: Map<string, Set<Level>>;
}

export const scenarioKey = (s: Scenario) => `${s.capability}${SEP}${s.requirement}${SEP}${s.name}`;

export function computeCoverage(index: SpecIndex, declarations: Declaration[]): Coverage {
  const byScenario = new Map<string, Set<Level>>();
  const dangling: Dangling[] = [];
  for (const d of declarations) {
    const r = resolveRef(d.ref, index);
    if (r.problem) {
      dangling.push({ declaration: d, reason: r.problem });
      continue;
    }
    // A requirement-level reference covers every scenario of that requirement.
    const targets = r.scenario
      ? [r.scenario]
      : index.scenarios.filter(
          (s) => s.capability === d.ref.split(SEP)[0].trim() && s.requirement === r.requirement,
        );
    for (const s of targets) {
      const set = byScenario.get(scenarioKey(s)) ?? new Set<Level>();
      set.add(d.level);
      byScenario.set(scenarioKey(s), set);
    }
  }
  return { dangling, byScenario };
}

const LEVEL_ORDER: Level[] = ["unit", "integration", "e2e", "design"];

/** Scenarios about layout, sizes, visibility, clipping, scrolling, focus or colour (spec: e2e-testing › Test-level policy). */
const LAYOUT_WORDS =
  /\b\d+\s?px\b|\b(width|height|layout|clipp\w*|overlap\w*|scroll\w*|visible|invisible|hidden|colou?r\w*|stripe|tinted?|underlin\w*|focus ring|align\w*|ellips\w*|truncat\w*|narrow|resiz\w*|off-screen|badge)\b|--[a-z][a-z-]+/i;

export function isLayoutClass(s: Scenario): boolean {
  return LAYOUT_WORDS.test([s.name, ...s.steps].join(" "));
}

/** A layout-class scenario needs a test that renders: jsdom and Rust tests cannot see layout. */
export function needsRealRender(s: Scenario, levels: Set<Level> | undefined): boolean {
  return isLayoutClass(s) && !!levels && !levels.has("e2e") && !levels.has("design");
}

export function renderReport(index: SpecIndex, coverage: Coverage): string {
  const finished = index.scenarios.filter((s) => s.status === "finished");
  const uncovered = finished.filter((s) => !coverage.byScenario.has(scenarioKey(s)));
  const lines: string[] = [
    "# Scenario coverage",
    "",
    "Generated by `pnpm check:coverage`. Do not edit by hand.",
    "",
    `${finished.length - uncovered.length} of ${finished.length} scenarios of finished capabilities have a covering test; **${uncovered.length} have none** (shown as manual).`,
    "",
    `${finished.filter((s) => needsRealRender(s, coverage.byScenario.get(scenarioKey(s)))).length} layout-class scenarios are covered only by jsdom or Rust tests and **need a real-render test**.`,
    "",
  ];
  const caps = [...new Set(finished.map((s) => s.capability))].sort();
  for (const cap of caps) {
    lines.push(`## ${cap}`, "", "| Requirement | Scenario | Levels |", "| --- | --- | --- |");
    for (const s of finished.filter((x) => x.capability === cap)) {
      const levels = coverage.byScenario.get(scenarioKey(s));
      const shown = levels
        ? LEVEL_ORDER.filter((l) => levels.has(l)).join(", ")
        : "**manual (no test)**";
      const flag = needsRealRender(s, levels) ? " — **needs real-render test**" : "";
      lines.push(`| ${esc(s.requirement)} | ${esc(s.name)} | ${shown}${flag} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

const esc = (s: string) => s.replace(/\|/g, "\\|");

function walk(dir: string, accept: (path: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "target" || name === "artifacts") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, accept, out);
    else if (accept(p)) out.push(p);
  }
  return out;
}

export function collectDeclarations(root: string): Declaration[] {
  const out: Declaration[] = [];
  const take = (files: string[], level: (f: string) => Level) => {
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      // a test that holds deliberately fake references says so on its first lines
      if (text.includes(IGNORE_MARKER)) continue;
      out.push(...parseDeclarations(text, relative(root, f), level(f)));
    }
  };
  take(
    walk(join(root, "e2e", "specs"), (p) => p.endsWith(".ts")),
    () => "e2e",
  );
  take(
    walk(join(root, "e2e", "design"), (p) => p.endsWith(".ts")),
    () => "design",
  );
  take(
    walk(join(root, "src"), (p) => /\.test\.tsx?$/.test(p)),
    () => "unit",
  );
  take(
    walk(join(root, "scripts"), (p) => /\.test\.ts$/.test(p)),
    () => "unit",
  );
  take(
    walk(join(root, "src-tauri", "src"), (p) => p.endsWith(".rs")),
    () => "unit",
  );
  take(
    walk(join(root, "src-tauri", "tests"), (p) => p.endsWith(".rs")),
    () => "integration",
  );
  return out;
}

function main(): number {
  const root = resolve(".");
  const index = indexSpecs(root);
  const coverage = computeCoverage(index, collectDeclarations(root));

  const report = resolve(root, "docs", "qa", "coverage.md");
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, renderReport(index, coverage));

  for (const d of coverage.dangling) {
    console.error(
      `FAIL ${d.declaration.file}:${d.declaration.line}: "${d.declaration.ref}" — ${d.reason}`,
    );
  }
  const finished = index.scenarios.filter((s) => s.status === "finished");
  const uncovered = finished.filter((s) => !coverage.byScenario.has(scenarioKey(s))).length;
  console.log(
    `${finished.length - uncovered}/${finished.length} scenarios covered; report: ${relative(root, report)}`,
  );
  return coverage.dangling.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
