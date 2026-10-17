import { Console } from "../pages/Console";
import { $, browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { Overlays, expectOverlayIntact } from "../helpers/overlay";
import { Explorer } from "../pages/Explorer";
import { StatusBar } from "../pages/StatusBar";
import { Toolbar } from "../pages/Toolbar";

// J-21 overlay sweep: every menu and dialog the shell opens stays inside the window, uncovered
// and unclipped, at a wide and a narrow window (spec: design-conformance › Overlay integrity;
// app-shell › Overlays are fully visible).
describe("J-21 overlays", () => {
  const data = withDataDir();

  before(async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("overlay-db", `${data.dir}/o.db`)]);
    await waitForShell();
    await launchApp(data);
    await Explorer.select("overlay-db");
    await browser.keys("Enter");
    await Console.waitForEditor(30_000);
  });
  after(async () => {
    await browser.setWindowSize(1440, 900);
  });

  for (const width of [1440, 880]) {
    describe(`${width}px wide`, () => {
      before(async () => {
        await browser.setWindowSize(width, 900);
        await browser.pause(300);
      });

      it(`opens the connection chip menu fully inside the window ${covers("app-shell › Connection chip menu")}`, async () => {
        const chip = $('.//button[@aria-haspopup="menu"][contains(., "overlay-db")]');
        await chip.waitForDisplayed({ timeout: 10_000 });
        await Overlays.openMenu(chip);
      });

      it("opens Settings", async () => {
        await Overlays.openDialog(Toolbar.settings());
      });

      it("opens About", async () => {
        await Overlays.openDialog(StatusBar.version());
      });
    });
  }

  it(`keeps a context menu opened at the window corner inside the window ${covers("app-shell › Menu near the edge")}`, async () => {
    await browser.setWindowSize(1024, 768);
    await browser.pause(300);
    const row = await Explorer.row("overlay-db");
    await browser.execute((el) => {
      (el as HTMLElement).dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: window.innerWidth - 4,
          clientY: window.innerHeight - 4,
        }),
      );
    }, row);
    await $('[role="menu"]').waitForDisplayed({ timeout: 5_000 });
    await expectOverlayIntact('[role="menu"]');
    await browser.keys("Escape");
  });
});
