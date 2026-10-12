// Design state matrix check (spec: design-conformance › Screen state matrix): every canvas screen
// has an entry in design/states.json, and every listed state has a fixture in the registry.
// Usage: pnpm check:design-states
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

export interface StatesFile {
  screens: Record<string, { states?: { id: string }[]; pending?: string }>;
}

export function canvasScreens(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".dc.html")).map((f) => f.replace(/\.dc\.html$/, ""));
}

export function stateProblems(canvas: string[], file: StatesFile, fixtureIds: string[]): string[] {
  const problems: string[] = [];
  for (const screen of canvas) {
    const def = file.screens[screen];
    if (!def) problems.push(`canvas screen ${screen} has no entry in design/states.json`);
    else if (!def.pending && (def.states ?? []).length === 0) {
      problems.push(`${screen} lists no states (and is not marked pending)`);
    }
  }
  for (const screen of Object.keys(file.screens)) {
    if (!canvas.includes(screen))
      problems.push(`design/states.json lists ${screen}, which is not a canvas screen`);
  }
  for (const [screen, def] of Object.entries(file.screens)) {
    for (const s of def.states ?? []) {
      if (!fixtureIds.includes(s.id))
        problems.push(`${screen} › ${s.id} has no fixture in the registry`);
    }
  }
  return problems;
}

/** Fixture ids, read from the registry's source so the check needs no browser. */
export function registryIds(source: string): string[] {
  return [...source.matchAll(/^\s{2}"?([a-z][\w-]*)"?:\s*\{/gm)]
    .map((m) => m[1])
    .filter((id) => id.includes("-"));
}

function main(): number {
  const file = JSON.parse(readFileSync(resolve("design", "states.json"), "utf8")) as StatesFile;
  const canvas = canvasScreens(readdirSync(resolve("design", "canvas")));
  const ids = registryIds(
    readFileSync(resolve("e2e", "fixtures", "states", "registry.ts"), "utf8"),
  );
  const problems = stateProblems(canvas, file, ids);
  for (const p of problems) console.error(`FAIL ${p}`);
  if (problems.length === 0)
    console.log(`ok: ${canvas.length} canvas screens, ${ids.length} state fixtures`);
  return problems.length === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(main());
}
