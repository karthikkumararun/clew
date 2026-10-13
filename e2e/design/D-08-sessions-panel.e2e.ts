import { $, browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { createIsolatedDb } from "../helpers/db";
import { Overlays } from "../helpers/overlay";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { copyFileSync } from "node:fs";

// D-08 the Sessions panel: its toggle stays reachable at a narrow window and its menus stay inside
// the window (spec: session-manager › Hidden panel can be reopened; design-conformance › Overlay integrity).
describe("D-08 sessions panel", () => {
  const data = withDataDir();

  before(async () => {
    const lite = await createIsolatedDb("sqlite");
    const path = `${data.dir}/sessions.sqlite`;
    copyFileSync(lite.name, path);
    await lite.cleanup();
    seedConnections(data.dir, [connectionFactory.sqlite("sessions-db", path, "development")]);
    await waitForShell();
    await launchApp(data);
    await Explorer.select("sessions-db");
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
    // a session exists once the console has run something
    await Console.setText("SELECT 1 AS one");
    await Console.run();
    await $('[data-testid="data-grid-canvas"]').waitForDisplayed({ timeout: 15_000 });
  });
  after(async () => {
    await browser.setWindowSize(1440, 900);
  });

  for (const width of [1440, 880]) {
    describe(`${width}px wide`, () => {
      before(async () => {
        await browser.setWindowSize(width, 900);
        await browser.pause(400);
      });

      it(`reopens from the status bar item ${covers("session-manager › Hidden panel can be reopened")}`, async () => {
        const item = $('.//footer//button[starts-with(normalize-space(.), "Sessions")]');
        // the panel exists in the page while it is open
        const isOpen = () =>
          browser.execute(() => document.querySelector('[data-testid="sessions-panel"]') !== null);
        const until = (open: boolean) =>
          browser.waitUntil(async () => (await isOpen()) === open, {
            timeoutMsg: `the Sessions panel should be ${open ? "open" : "hidden"}`,
          });
        if (!(await isOpen())) await item.click();
        await until(true);
        await $('[aria-label="Hide panel"]').click();
        await until(false);
        await item.click();
        await until(true);
      });

      it(`keeps the attach menu inside the window ${covers("design-conformance › Overlay integrity")}`, async () => {
        await $('[data-testid="sessions-panel"] [role="treeitem"][aria-level="2"]').click();
        await Overlays.openMenu($("button=Attach to…"));
      });
    });
  }
});
