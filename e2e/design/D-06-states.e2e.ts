import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolve } from "node:path";
import { browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { seedConnections } from "../helpers/connections";
import { seedUiState } from "../helpers/uiState";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { setViewport } from "../helpers/geometry";
import { metrics, regionProblems } from "../helpers/metrics";
import { overlayProblems } from "../helpers/overlay";
import { STATES, stopStateServices } from "../fixtures/states/registry";

// D-06 every state listed in design/states.json is reached in the real app and captured at the
// reference size (spec: design-conformance › Every canvas state is reachable). Per state it writes
// e2e/artifacts/design/<id>.png and <id>.json (metric results, overlay problems, mask rectangles)
// for `pnpm qa:design`.
interface StatesFile {
  screens: Record<string, { states?: { id: string; description: string }[]; pending?: string }>;
}
const states = JSON.parse(readFileSync(resolve("design", "states.json"), "utf8")) as StatesFile;
const OUT = resolve("e2e", "artifacts", "design");

describe("D-06 canvas states", () => {
  const data = withDataDir();

  before(async () => {
    mkdirSync(OUT, { recursive: true });
    await waitForShell();
    await browser.setWindowSize(1440, 900);
  });
  after(async () => {
    await browser.setWindowSize(1440, 900);
    await stopStateServices();
  });

  for (const [screen, def] of Object.entries(states.screens)) {
    for (const state of def.states ?? []) {
      it(`reaches ${screen} › ${state.id} ${covers("design-conformance › Every canvas state is reachable")}`, async () => {
        const fixture = STATES[state.id];
        if (!fixture) throw new Error(`state ${state.id} has no fixture in e2e/fixtures/states/registry.ts`);
        // every state starts clean: no tabs restored from the previous state
        seedUiState(data.dir, { "session.tabs": "" });
        seedConnections(data.dir, fixture.connections ? await fixture.connections(data.dir) : []);
        // AI is off unless the state turns it on
        rmSync(join(data.dir, "ai.json"), { force: true });
        await fixture.prepare?.(data.dir);
        await launchApp(data);
        await browser.setWindowSize(1440, 900);
        await browser.pause(300);
        await fixture.steps?.();
        // the window-state plugin restores a saved size a moment after start; fix the size last
        const viewport = await setViewport(1440, 900);
        await browser.pause(300);

        // metric results for every region on screen
        const problems: string[] = [];
        for (const name of Object.keys(metrics.regions)) {
          const found = await browser.execute((n: string) => document.querySelector(`[data-metric="${n}"]`) !== null, name);
          if (found) problems.push(...(await regionProblems(name)));
        }
        const overlay = await browser.execute(() => !!document.querySelector('[role="dialog"], [role="menu"]'));
        const overlayIssues = overlay
          ? await overlayProblems('[role="dialog"], [role="menu"]')
          : [];

        const masks = await browser.execute((sels: string[]) => {
          const dpr = window.devicePixelRatio || 1;
          return sels.flatMap((s) =>
            Array.from(document.querySelectorAll(s)).map((el) => {
              const r = el.getBoundingClientRect();
              return {
                x: Math.floor(r.x * dpr),
                y: Math.floor(r.y * dpr),
                width: Math.ceil(r.width * dpr),
                height: Math.ceil(r.height * dpr),
              };
            }),
          );
        }, fixture.masks ?? []);

        // a dialog has one header: a second, hidden-but-drawn one would show twice
        const closes = await browser.execute(
          () =>
            Array.from(document.querySelectorAll('[role="dialog"] button[aria-label="Close"]')).filter(
              (b) => (b as HTMLElement).offsetParent !== null,
            ).length,
        );
        if (closes > 1) problems.push(`the dialog shows ${closes} Close buttons: its header is drawn twice`);

        await browser.saveScreenshot(resolve(OUT, `${state.id}.png`));
        writeFileSync(
          resolve(OUT, `${state.id}.json`),
          JSON.stringify({ id: state.id, screen, description: state.description, viewport, problems, overlayIssues, masks }, null, 2),
        );
        if (problems.length > 0 || overlayIssues.length > 0) {
          throw new Error(`${state.id}: ${[...problems, ...overlayIssues].join("; ")}`);
        }
      });
    }
  }
});
