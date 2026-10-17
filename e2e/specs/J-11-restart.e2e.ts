import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { TabStrip } from "../pages/TabStrip";

// J-11 restart restores tabs, sidebar and explorer expansion.
describe("J-11 restart", () => {
  const data = withDataDir();
  const texts = ["SELECT 1 AS one", "SELECT 2 AS two", "SELECT 3 AS three"];

  it("opens three consoles with their own text", async () => {
    seedConnections(data.dir, [
      connectionFactory.sqlite("restart-sqlite", `${data.dir}/restart.db`),
    ]);
    await launchApp(data);
    await Explorer.select("restart-sqlite");
    await browser.keys("Enter"); // connect and open a console
    await Console.waitForEditor(20_000);
    await Console.setText(texts[0]);
    for (const text of texts.slice(1)) {
      await TabStrip.newConsole().click();
      await Console.setText(text);
    }
    await expect(TabStrip.tabs()).toBeElementsArrayOfSize(3);
  });

  it(`reopens the same tabs in order with the same text ${covers("app-shell › Restart restores tabs")}`, async () => {
    await launchApp(data);
    await expect(TabStrip.tabs()).toBeElementsArrayOfSize(3);
    for (let i = 0; i < texts.length; i++) {
      await TabStrip.select(i);
      await browser.waitUntil(async () => (await Console.text()) === texts[i], {
        timeoutMsg: `tab ${i + 1} should show "${texts[i]}", shows "${await Console.text()}"`,
      });
    }
  });
});
