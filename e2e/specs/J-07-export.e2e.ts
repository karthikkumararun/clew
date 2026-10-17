import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import type { IsolatedDb } from "../helpers/db";
import { queueDialog } from "../helpers/dialogs";
import { openShopConsole } from "../helpers/fixtures";
import { Console } from "../pages/Console";
import { ExportDialog } from "../pages/ExportDialog";
import { Explorer } from "../pages/Explorer";
import { Grid } from "../pages/Grid";
import { TabStrip } from "../pages/TabStrip";

// J-07 export 100,000 rows to CSV with progress, and cancel deleting the partial file.
describe("J-07 export", () => {
  const data = withDataDir();
  let db: IsolatedDb;
  let connection: string;
  const out = (name: string) => join(data.dir, "..", name);
  before(async () => {
    ({ db, connection } = await openShopConsole(data));
  });
  after(async () => {
    await db.cleanup();
  });

  it(`streams every row of a big table to a CSV file ${covers("data-grid › Export all rows of a big table")}`, async () => {
    await Explorer.reveal([connection, db.name, "public", "tables"]);
    await Explorer.open("events");
    await browser.waitUntil(async () => (await Grid.rowCount()) > 0, { timeout: 20_000 });
    await $('.//button[contains(., "Export")]').click();
    await ExportDialog.dialog().waitForDisplayed();
    await ExportDialog.allRows().click();
    const file = out("events.csv");
    queueDialog(data.dialogQueue, file);
    await ExportDialog.exportButton().click();
    await expect(ExportDialog.status()).toHaveText(
      expect.stringMatching(/Exported 100[,.\s\u00a0\u202f]?000 rows/),
      { wait: 60_000 },
    );
    await ExportDialog.doneButton().click();
    const lines = readFileSync(file, "utf8").trimEnd().split(/\r?\n/);
    expect(lines).toHaveLength(100_001); // header + rows
    expect(lines[0]).toBe("id,user_id,kind,amount_cents,occurred_at");
  });

  it(`deletes the partial file when an export is cancelled ${covers("data-grid › Cancelled export")}`, async () => {
    await TabStrip.select(0); // the console
    // slow enough to cancel while it streams
    await Console.setText("SELECT id, pg_sleep(0.002) AS slow FROM events");
    await Console.run();
    await browser.waitUntil(async () => (await Grid.rowCount()) > 0, { timeout: 30_000 });
    await $('.//button[contains(., "Export")]').click();
    await ExportDialog.dialog().waitForDisplayed();
    await ExportDialog.allRows().click();
    const file = out("partial.csv");
    queueDialog(data.dialogQueue, file);
    await ExportDialog.exportButton().click();
    await expect(ExportDialog.status()).toHaveText(expect.stringContaining("rows"), {
      wait: 30_000,
    });
    await ExportDialog.cancelExport().click();
    await ExportDialog.dialog().waitForExist({ reverse: true, timeout: 30_000 });
    expect(existsSync(file)).toBe(false);
  });
});
