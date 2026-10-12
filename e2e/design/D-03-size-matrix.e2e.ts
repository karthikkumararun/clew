import { $, browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { isInsideWindow } from "../helpers/geometry";
import { Overlays } from "../helpers/overlay";
import { Explorer } from "../pages/Explorer";
import { StatusBar } from "../pages/StatusBar";
import { Toolbar } from "../pages/Toolbar";

// D-03 window-size matrix: at each size the page does not scroll sideways, the toolbar controls
// are on screen, overlays stay intact and a collapsed sidebar can be opened
// (spec: design-conformance › Window-size and scale matrix). Sizes are CSS pixels, so the same
// checks run at 125% and 150% display scaling (see the design job in .github/workflows/e2e.yml).
const SIZES: [number, number][] = [
  [1440, 900],
  [1280, 800],
  [1024, 768],
  [880, 700],
  [640, 480], // the minimum window size (tauri.conf.json)
];

describe("D-03 window-size matrix", () => {
  const data = withDataDir();

  before(async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("matrix-db", `${data.dir}/x.db`)]);
    await waitForShell();
    await launchApp(data);
    await Explorer.select("matrix-db");
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
  });
  after(async () => {
    await browser.setWindowSize(1440, 900);
  });

  for (const [w, h] of SIZES) {
    it(`${w}x${h}: no horizontal scroll, controls reachable, overlays intact ${covers("design-conformance › Narrow window")}`, async () => {
      await browser.setWindowSize(w, h);
      await browser.pause(300);

      const sideways = await browser.execute(
        () => document.documentElement.scrollWidth > window.innerWidth + 1,
      );
      if (sideways) throw new Error(`the page scrolls sideways at ${w}x${h}`);

      for (const [name, el] of [
        ["Toggle sidebar", Toolbar.toggleSidebar()],
        ["Settings", Toolbar.settings()],
        ["version", StatusBar.version()],
      ] as const) {
        if (!(await isInsideWindow(el))) throw new Error(`${name} is not inside the ${w}x${h} window`);
      }

      await Overlays.openDialog(Toolbar.settings());

      if (w < 900) {
        // narrow: the sidebar is collapsed behind the toolbar control and opens as an overlay
        if (await $("aria/Explorer").isDisplayed()) throw new Error(`sidebar is not collapsed at ${w}px`);
        await Toolbar.toggleSidebar().click();
        await $("aria/Explorer").waitForDisplayed({ timeout: 5_000 });
        if (!(await isInsideWindow($("aria/Explorer")))) throw new Error(`the sidebar overlay leaves the ${w}x${h} window`);
        await Toolbar.toggleSidebar().click(); // close it again
        await $("aria/Explorer").waitForDisplayed({ reverse: true, timeout: 5_000 });
      }
    });
  }
});

