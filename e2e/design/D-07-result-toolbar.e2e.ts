import { $, browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { createIsolatedDb } from "../helpers/db";
import { Overlays } from "../helpers/overlay";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { Grid } from "../pages/Grid";
import { copyFileSync } from "node:fs";

// D-07 the console result toolbar: at 1440 and 1024px it wraps instead of clipping, and every
// menu it opens (table chooser, auto-refresh, options, cell menu) stays inside the window and
// closes with Esc, returning focus (spec: design-conformance › Overlay integrity).
const WIDTHS = [1440, 1024];

describe("D-07 result toolbar", () => {
  const data = withDataDir();

  before(async () => {
    const lite = await createIsolatedDb("sqlite");
    const path = `${data.dir}/toolbar.sqlite`;
    copyFileSync(lite.name, path);
    await lite.cleanup();
    seedConnections(data.dir, [connectionFactory.sqlite("toolbar-db", path, "development")]);
    await waitForShell();
    await launchApp(data);
    await Explorer.select("toolbar-db");
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
    await Console.setText(
      "SELECT o.id AS oid, o.status, u.id AS uid, u.name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id LIMIT 10",
    );
    await Console.run();
    await browser.waitUntil(async () => (await Grid.rowCount()) === 10, { timeoutMsg: "10 rows" });
    await $('.//button[starts-with(@aria-label, "Editing ")]').waitForDisplayed({ timeout: 20_000 });
  });
  after(async () => {
    await browser.setWindowSize(1440, 900);
  });

  for (const width of WIDTHS) {
    describe(`${width}px wide`, () => {
      before(async () => {
        await browser.setWindowSize(width, 900);
        await browser.pause(400);
      });

      it("wraps its tools instead of clipping them", async () => {
        const bad = await browser.execute(() => {
          const tabs = document.querySelector('[role="tablist"][aria-label="Result views"]');
          const header = tabs?.parentElement;
          if (!header) return ["the result toolbar was not found"];
          const hr = header.getBoundingClientRect();
          const out: string[] = [];
          if (header.scrollWidth > header.clientWidth + 1) out.push("the toolbar scrolls sideways");
          for (const el of Array.from(header.querySelectorAll("button, [role=radiogroup]"))) {
            const r = el.getBoundingClientRect();
            if (r.width === 0) continue;
            if (r.right > hr.right + 1 || r.bottom > hr.bottom + 1 || r.left < hr.left - 1) {
              out.push(`${el.getAttribute("aria-label") ?? el.textContent?.trim()} sits outside the toolbar`);
            }
          }
          return out;
        });
        if (bad.length > 0) throw new Error(bad.join("; "));
      });

      it(`keeps the table chooser inside the window ${covers("design-conformance › Overlay integrity")}`, async () => {
        await Overlays.openMenu($('.//button[starts-with(@aria-label, "Editing ")]'));
      });

      it("keeps the auto-refresh menu inside the window", async () => {
        await Overlays.openMenu($('.//button[starts-with(@aria-label, "Auto-refresh")]'));
      });

      it("keeps the options menu inside the window", async () => {
        await Overlays.openMenu($("aria/More options"));
      });
    });
  }
});
