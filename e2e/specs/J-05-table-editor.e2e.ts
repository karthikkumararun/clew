import { $, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import type { Db, IsolatedDb } from "../helpers/db";
import { openSecond, tablesPath } from "../helpers/dialect";
import { openShopConsole } from "../helpers/fixtures";
import { Explorer } from "../pages/Explorer";
import { Grid } from "../pages/Grid";
import { TableEditor } from "../pages/TableEditor";

// J-05 table editor: filter, page, edit a cell, preview SQL, submit, verify from a second
// connection, and the changed-by-someone-else conflict.
describe("J-05 table editor", () => {
  const data = withDataDir();
  let db: IsolatedDb;
  let second: Db; // a second connection to the same database, as another user would have
  let connection: string;
  before(async () => {
    ({ db, connection } = await openShopConsole(data));
    second = await openSecond(db);
  });
  after(async () => {
    await second.close();
    await db.cleanup();
  });

  it(`opens a table on its first page sorted by primary key ${covers("table-editor › Open a table")}`, async () => {
    await Explorer.reveal(tablesPath(connection, db));
    await Explorer.open("orders");
    await browser.waitUntil(async () => (await Grid.rowCount()) > 0, {
      timeoutMsg: "rows expected",
    });
    expect(await Grid.cell(0, "id")).toBe("1");
    expect(await Grid.cell(1, "id")).toBe("2");
  });

  it(`applies a filter ${covers("table-editor › Apply a filter")}`, async () => {
    await TableEditor.applyFilter("status = 'pending' AND total > 100");
    await browser.waitUntil(
      async () => (await Grid.columnValues("status")).every((s) => s === "pending"),
      {
        timeoutMsg: "only pending rows expected",
      },
    );
    expect((await Grid.rowCount()) < 200).toBe(true);
    await TableEditor.applyFilter("");
    await browser.waitUntil(async () => (await Grid.rowCount()) === 200, {
      timeoutMsg: "all 200 rows expected after clearing the filter",
    });
  });

  it(`stages an edit, previews and submits it ${covers("table-editor › Edit a cell", "table-editor › Preview SQL", "table-editor › Submit succeeds")}`, async () => {
    await TableEditor.editCell(0, "status", "shipped");
    await expect(TableEditor.pendingBar()).toHaveText(expect.stringContaining("1 pending change"));
    await TableEditor.previewButton().click();
    await expect(TableEditor.generatedSql()).toHaveText(expect.stringContaining("UPDATE"));
    await expect(TableEditor.generatedSql()).toHaveText(expect.stringContaining("shipped"));
    await browser.keys("Escape");
    await TableEditor.submitButton().click();
    await TableEditor.pendingBar().waitForExist({ reverse: true, timeout: 10_000 });
    const [row] = await second.query("SELECT status FROM orders WHERE id = 1");
    expect(row.status).toBe("shipped");
  });

  it(`refuses to overwrite a row changed by someone else ${covers("table-editor › Row changed by someone else")}`, async () => {
    await TableEditor.editCell(1, "status", "cancelled");
    await second.exec("UPDATE orders SET status = 'paid' WHERE id = 2");
    await TableEditor.submitButton().click();
    await expect($('[aria-label="Pending changes"] [role="alert"]')).toHaveText(
      expect.stringContaining("changed by someone else"),
      { wait: 10_000 },
    );
    const [row] = await second.query("SELECT status FROM orders WHERE id = 2");
    expect(row.status).toBe("paid"); // untouched
  });
});
