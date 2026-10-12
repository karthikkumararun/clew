import { $, browser, expect } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { isInsideWindow } from "../helpers/geometry";
import { LAYOUT_KEYS, seedUiState } from "../helpers/uiState";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { Explorer } from "../pages/Explorer";
import { Toolbar } from "../pages/Toolbar";

// J-20 hidden-state sweep: start the app with every combination of saved layout state at a wide
// and a narrow window; whatever is hidden must have a visible control that brings it back
// (spec: app-shell › Hidden areas can always be restored).
const WIDTHS = [1440, 880];

describe("J-20 hidden-state sweep", () => {
  const data = withDataDir();

  // The window size is saved per user by the window-state plugin, outside the test data
  // directory, so a previous run's size can come back: set it explicitly, and put it back.
  before(async () => {
    await waitForShell();
    await browser.setWindowSize(1440, 900);
  });
  after(async () => {
    await browser.setWindowSize(1440, 900);
  });

  for (const width of WIDTHS) {
    for (const sidebar of ["true", "false"]) {
      it(`${width}px, saved sidebar ${sidebar === "true" ? "shown" : "hidden"}: the toolbar control restores it ${covers("app-shell › Every hidden state has an exit")}`, async () => {
        seedUiState(data.dir, { [LAYOUT_KEYS.sidebar]: sidebar, [LAYOUT_KEYS.sidePanel]: "false" });
        await launchApp(data);
        const { height } = await browser.getWindowSize();
        await browser.setWindowSize(width, height);
        await Toolbar.toggleSidebar().waitForDisplayed({ timeout: 10_000 });
        expect(await isInsideWindow(Toolbar.toggleSidebar())).toBe(true);

        // Narrow windows collapse the sidebar whatever was saved; wide ones follow the saved state.
        const collapsed = width < 900 || sidebar === "false";
        const explorer = $("aria/Explorer");
        expect(await explorer.isDisplayed()).toBe(!collapsed);
        if (collapsed) {
          await Toolbar.toggleSidebar().click();
          await explorer.waitForDisplayed({ timeout: 5_000 });
          expect(await isInsideWindow(explorer)).toBe(true);
        }
      });
    }
  }

  it(`groups connections under environment headers until the user makes a group ${covers("database-explorer › All four environments", "database-explorer › Empty headers are hidden")}`, async () => {
    seedUiState(data.dir, { [LAYOUT_KEYS.sidebar]: "true" });
    seedConnections(data.dir, [
      connectionFactory.sqlite("local-lite", `${data.dir}/a.db`, "local"),
      connectionFactory.sqlite("prod-lite", `${data.dir}/b.db`, "production"),
    ]);
    await launchApp(data);
    const { height } = await browser.getWindowSize();
    await browser.setWindowSize(1440, height);
    await Explorer.row("prod-lite").waitForDisplayed({ timeout: 10_000 });
    const texts = await Promise.all(
      Array.from(await Explorer.rows()).map(async (r) => (await r.getText()).split("\n")[0].trim()),
    );
    const heads = texts.filter((t) => t === t.toUpperCase());
    expect(heads).toEqual(["PRODUCTION", "LOCAL"]);
  });
});
