import { $, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import type { IsolatedDb } from "../helpers/db";
import { openShopConsole } from "../helpers/fixtures";
import { Explorer } from "../pages/Explorer";
import { Grid } from "../pages/Grid";
import { TableEditor } from "../pages/TableEditor";
import { TabStrip } from "../pages/TabStrip";

// J-06 record panel: follow a foreign key and a referenced-by link.
describe("J-06 record panel", () => {
  const data = withDataDir();
  let db: IsolatedDb;
  let connection: string;
  before(async () => {
    ({ db, connection } = await openShopConsole(data));
    await Explorer.reveal([connection, db.name, "public", "tables"]);
    await Explorer.open("orders");
    await browser.waitUntil(async () => (await Grid.rowCount()) === 200, { timeout: 20_000 });
    await Grid.select(0, "id");
    await TableEditor.recordPanelToggle().click();
    await TableEditor.record().waitForDisplayed();
  });
  after(async () => {
    await db.cleanup();
  });

  it("shows the selected row", async () => {
    await expect(TableEditor.record()).toHaveText(expect.stringContaining("Record #1"));
    await expect(TableEditor.record()).toHaveText(expect.stringContaining("status"));
  });

  it(`opens the referenced row filtered by key ${covers("table-editor › Follow a reference")}`, async () => {
    const link = await $('.//*[@aria-label="References"]//button[contains(., "users #8")]');
    await link.click();
    await browser.waitUntil(async () => (await TabStrip.tabs()).length === 3, {
      timeoutMsg: "users tab expected",
    });
    await expect(TableEditor.where()).toHaveValue(expect.stringContaining('"id" = 8'));
    await browser.waitUntil(async () => (await Grid.rowCount()) === 1, {
      timeoutMsg: "one filtered row expected",
    });
    expect(await Grid.cell(0, "id")).toBe("8");
  });

  it(`opens the referencing table filtered to the record ${covers("table-editor › Referenced by")}`, async () => {
    await TabStrip.select(1); // back to orders
    await browser.waitUntil(async () => (await Grid.rowCount()) === 200, { timeout: 20_000 });
    await Grid.select(0, "id");
    const link = await $('.//*[@aria-label="Referenced by"]//button[contains(., "order_items")]');
    await link.waitForDisplayed({ timeout: 15_000 });
    await expect(link).toHaveText(expect.stringContaining("2 rows"));
    await link.click();
    await browser.waitUntil(async () => (await TabStrip.tabs()).length === 4, {
      timeoutMsg: "order_items tab expected",
    });
    await expect(TableEditor.where()).toHaveValue(expect.stringContaining('"order_id" = 1'));
    await browser.waitUntil(async () => (await Grid.rowCount()) === 2, {
      timeoutMsg: "two referencing rows expected",
    });
  });
});
