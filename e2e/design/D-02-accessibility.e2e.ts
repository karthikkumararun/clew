import { $, browser, expect } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { describeViolations, focusFirstStop, seriousViolations, tabStops } from "../helpers/a11y";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { Explorer } from "../pages/Explorer";
import { Toolbar } from "../pages/Toolbar";

// D-02 accessibility: an axe-core scan of each state (serious and critical violations fail), the
// tab order of the toolbar and the focus ring (spec: design-conformance › Accessibility checks).
describe("D-02 accessibility", () => {
  const data = withDataDir();

  before(async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("a11y-db", `${data.dir}/a.db`)]);
    await waitForShell();
    await launchApp(data);
    await browser.setWindowSize(1440, 900);
  });

  const scan = async (state: string) => {
    const v = await seriousViolations();
    if (v.length > 0) throw new Error(`${state}: ${describeViolations(v)}`);
  };

  it("has no serious violations on the Welcome screen", async () => {
    await scan("Welcome");
  });

  it("has no serious violations with a console open", async () => {
    await Explorer.select("a11y-db");
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
    await scan("Console");
  });

  it("has no serious violations in Settings", async () => {
    await Toolbar.settings().click();
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10_000 });
    await scan("Settings");
    await browser.keys("Escape");
  });

  it(`shows a 2px accent focus ring on the first toolbar button ${covers("design-conformance › Visible focus")}`, async () => {
    const f = await focusFirstStop('[data-metric="toolbar"]');
    if (!f.focusVisible) throw new Error(`${f.label} is focused but does not match :focus-visible`);
    if (f.outlineWidth !== "2px" || f.outlineColor !== f.accent) {
      throw new Error(`focus ring on ${JSON.stringify(f)}: want 2px ${f.accent}`);
    }
  });

  it("visits the toolbar controls in visual order", async () => {
    const stops = await tabStops('[data-metric="toolbar"]');
    expect(stops.length).toBeGreaterThan(2);
    const xs = stops.map((s) => s.x);
    expect([...xs].sort((a, b) => a - b)).toEqual(xs);
  });
});
