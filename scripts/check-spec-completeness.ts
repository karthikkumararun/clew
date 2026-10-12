// Spec-to-test completeness (spec: e2e-testing › Spec-to-test completeness). Screens each
// requirement of the finished capabilities and active changes:
//   - scenarios with no test at any level that are not marked manual,
//   - requirements with no scenario at all,
//   - requirement prose that lists items or promises defaults with fewer scenarios than items, or
//     whose scenarios never mention the promised noun ("probably under-specified").
// Known gaps live in docs/qa/known-gaps.json: they can shrink, but a new gap fails the check.
// Usage: tsx scripts/check-spec-completeness.ts [--write-baseline "reason"]
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  collectDeclarations,
  computeCoverage,
  indexSpecs,
  scenarioKey,
  type Scenario,
} from "./check-scenario-coverage";

export interface RequirementText {
  capability: string;
  name: string;
  prose: string;
  status: "finished" | "active";
}

export interface Gap {
  key: string;
  reason: string;
}

export interface KnownGaps {
  uncovered: Gap[];
  requirementsWithoutScenario: Gap[];
  underSpecified: Gap[];
}

const SEP = "›";

/** Requirement prose (the lines between the heading and its first scenario). */
export function parseRequirements(
  text: string,
  capability: string,
  status: RequirementText["status"],
): RequirementText[] {
  const out: RequirementText[] = [];
  let cur: RequirementText | undefined;
  let inScenario = false;
  for (const line of text.split("\n")) {
    const req = /^###\s+Requirement:\s*(.+?)\s*$/.exec(line);
    if (req) {
      cur = { capability, name: req[1], prose: "", status };
      out.push(cur);
      inScenario = false;
      continue;
    }
    if (/^####\s+Scenario:/.test(line)) inScenario = true;
    else if (/^#{1,3}\s/.test(line)) cur = undefined;
    if (cur && !inScenario) cur.prose += `${line}\n`;
  }
  return out;
}

/** Enumerated items a requirement's prose promises: parenthetical and colon lists, "such as". */
export function enumeratedItems(prose: string): number {
  let best = 0;
  const lists = [
    ...[...prose.matchAll(/\(([^()]*,[^()]*)\)/g)].map((m) => m[1]),
    ...[...prose.matchAll(/(?:such as|including|for example|e\.g\.)\s+([^.;]+)/gi)].map(
      (m) => m[1],
    ),
    ...[...prose.matchAll(/:\s*([^.:]+,[^.:]+)\./g)].map((m) => m[1]),
  ];
  for (const l of lists) {
    const items = l
      .split(/,|\band\b|\bor\b/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    best = Math.max(best, items.length);
  }
  return best;
}

const PROMISE = /\b(default(?:s)?|for each|every)\s+(\w+)/gi;
const STOP = new Set(["the", "a", "an", "of", "to", "in", "is", "and", "or", "that", "it", "its"]);

/** Phrases such as "default groups" that none of the requirement's scenarios mention. */
export function unmatchedPhrases(prose: string, scenarioText: string): string[] {
  const hay = scenarioText.toLowerCase();
  const out: string[] = [];
  for (const m of prose.matchAll(PROMISE)) {
    const kind = m[1].toLowerCase();
    const noun = m[2]
      .toLowerCase()
      .split(/\s+/)
      .find((w) => !STOP.has(w));
    if (!noun || noun.length < 4) continue;
    const stem = noun.slice(0, Math.max(4, noun.length - 2));
    if (kind.startsWith("default") ? !hay.includes("default") : !hay.includes(stem)) {
      out.push(`${m[1]} ${m[2]}`);
    }
  }
  return [...new Set(out)];
}

export interface Findings {
  uncovered: string[];
  requirementsWithoutScenario: string[];
  underSpecified: { key: string; why: string }[];
}

export function analyse(
  scenarios: Scenario[],
  requirements: RequirementText[],
  covered: Set<string>,
): Findings {
  const f: Findings = { uncovered: [], requirementsWithoutScenario: [], underSpecified: [] };
  for (const s of scenarios) {
    if (s.status !== "finished") continue;
    if (!covered.has(scenarioKey(s)) && !s.manual) f.uncovered.push(scenarioKey(s));
  }
  for (const r of requirements) {
    const own = scenarios.filter((s) => s.capability === r.capability && s.requirement === r.name);
    const key = `${r.capability}${SEP}${r.name}`;
    if (own.length === 0) {
      f.requirementsWithoutScenario.push(key);
      continue;
    }
    const items = enumeratedItems(r.prose);
    if (items > own.length && items >= 3) {
      f.underSpecified.push({ key, why: `${items} listed items, ${own.length} scenarios` });
    }
    const text = own.map((s) => [s.name, ...s.steps].join(" ")).join(" ");
    for (const phrase of unmatchedPhrases(r.prose, text)) {
      f.underSpecified.push({ key, why: `no scenario mentions "${phrase}"` });
    }
  }
  return f;
}

/** Findings that are neither in the baseline nor fixed: these fail the check. */
export function newGaps(f: Findings, known: KnownGaps): string[] {
  const has = (list: Gap[], key: string) => list.some((g) => g.key === key);
  return [
    ...f.uncovered.filter((k) => !has(known.uncovered, k)).map((k) => `uncovered scenario: ${k}`),
    ...f.requirementsWithoutScenario
      .filter((k) => !has(known.requirementsWithoutScenario, k))
      .map((k) => `requirement without a scenario: ${k}`),
    ...f.underSpecified
      .filter((u) => !has(known.underSpecified, `${u.key}${SEP}${u.why}`))
      .map((u) => `probably under-specified: ${u.key} (${u.why})`),
  ];
}

/** Baseline entries that no longer apply: the gap was closed, so the entry can go. */
export function closedGaps(f: Findings, known: KnownGaps): string[] {
  const now = new Set([
    ...f.uncovered,
    ...f.requirementsWithoutScenario,
    ...f.underSpecified.map((u) => `${u.key}${SEP}${u.why}`),
  ]);
  return [...known.uncovered, ...known.requirementsWithoutScenario, ...known.underSpecified]
    .map((g) => g.key)
    .filter((k) => !now.has(k));
}

function readRequirements(root: string): RequirementText[] {
  const out: RequirementText[] = [];
  const dirs: [string, RequirementText["status"]][] = [
    [join(root, "openspec", "specs"), "finished"],
  ];
  const changes = join(root, "openspec", "changes");
  if (existsSync(changes)) {
    for (const c of readdirSync(changes)) {
      if (c !== "archive") dirs.push([join(changes, c, "specs"), "active"]);
    }
  }
  for (const [dir, status] of dirs) {
    if (!existsSync(dir)) continue;
    for (const cap of readdirSync(dir)) {
      const f = join(dir, cap, "spec.md");
      if (existsSync(f)) out.push(...parseRequirements(readFileSync(f, "utf8"), cap, status));
    }
  }
  return out;
}

const GAPS_FILE = ["docs", "qa", "known-gaps.json"];

function main(): number {
  const root = resolve(".");
  const index = indexSpecs(root);
  const coverage = computeCoverage(index, collectDeclarations(root));
  const covered = new Set(coverage.byScenario.keys());
  const finishedReqs = readRequirements(root).filter((r) => r.status === "finished");
  const found = analyse(index.scenarios, finishedReqs, covered);
  const file = resolve(root, ...GAPS_FILE);

  const w = process.argv.indexOf("--write-baseline");
  if (w >= 0) {
    const reason = process.argv[w + 1] ?? "baseline";
    const gap = (key: string): Gap => ({ key, reason });
    const known: KnownGaps = {
      uncovered: found.uncovered.map(gap),
      requirementsWithoutScenario: found.requirementsWithoutScenario.map(gap),
      underSpecified: found.underSpecified.map((u) => gap(`${u.key}${SEP}${u.why}`)),
    };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(known, null, 2)}\n`);
    console.log(
      `baseline written: ${found.uncovered.length} uncovered, ${found.requirementsWithoutScenario.length} without scenario, ${found.underSpecified.length} under-specified`,
    );
    return 0;
  }

  const known: KnownGaps = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as KnownGaps)
    : { uncovered: [], requirementsWithoutScenario: [], underSpecified: [] };
  const fresh = newGaps(found, known);
  for (const g of fresh) console.error(`FAIL ${g}`);
  for (const k of closedGaps(found, known))
    console.log(`note: gap closed, remove from known-gaps.json: ${k}`);
  console.log(
    `${found.uncovered.length} uncovered, ${found.requirementsWithoutScenario.length} requirements without a scenario, ${found.underSpecified.length} probably under-specified (${fresh.length} new)`,
  );
  return fresh.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
