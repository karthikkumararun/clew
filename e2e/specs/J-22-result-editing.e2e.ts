import { $, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { openSecond } from "../helpers/dialect";
import type { Db, IsolatedDb } from "../helpers/db";
import { openShopConsole } from "../helpers/fixtures";
import { Console } from "../pages/Console";
import { Grid } from "../pages/Grid";
import { TableEditor } from "../pages/TableEditor";

// J-22 editing the result of a query in the console: chip, cell edit, add and delete rows, preview,
// submit, read-back, and the table chooser of a join (spec: result-editing).
describe("J-22 result editing", () => {
  const data = withDataDir();
  let db: IsolatedDb;
  let second: Db;

  const run = async (sql: string, rows: number) => {
    await Console.setText(sql);
    await Console.run();
    await browser.waitUntil(async () => (await Grid.rowCount()) === rows, {
      timeoutMsg: `${rows} rows expected`,
    });
  };

  before(async () => {
    ({ db } = await openShopConsole(data));
    second = await openSecond(db);
  });
  after(async () => {
    await second.close();
    await db.cleanup();
  });

  it(`names the edit table and its key in a chip ${covers("result-editing › Single table with its key")}`, async () => {
    await run(
      "SELECT id, user_id, status, total, created_at FROM orders ORDER BY id DESC LIMIT 20",
      20,
    );
    await $("aria/Editing table orders, key id").waitForDisplayed({ timeout: 20_000 });
  });

  it(`stages a cell edit, previews the SQL, submits and shows the saved value ${covers("result-editing › Change a cell", "result-editing › Preview", "result-editing › Auto-commit submit")}`, async () => {
    const id = await Grid.cell(0, "id");
    await TableEditor.editCell(0, "status", "shipped");
    await expect(TableEditor.pendingBar()).toHaveText(expect.stringContaining("1 pending change"));
    await TableEditor.previewButton().click();
    await expect(TableEditor.generatedSql()).toHaveText(expect.stringContaining("UPDATE"));
    await browser.keys("Escape");
    await TableEditor.submitButton().click();
    await TableEditor.pendingBar().waitForExist({ reverse: true, timeout: 15_000 });
    const [row] = await second.query(`SELECT status FROM orders WHERE id = ${id}`);
    expect(row.status).toBe("shipped");
    expect(await Grid.cell(0, "status")).toBe("shipped");
  });

  it(`refuses to edit a key cell of a loaded row ${covers("result-editing › Key columns of existing rows")}`, async () => {
    await Grid.select(0, "id");
    await browser.keys("Enter");
    await expect($("aria/Value of id")).not.toBeDisplayed();
    // a read-only cell opens the value viewer instead; close it
    await browser.keys("Escape");
  });

  it(`adds a row, submits it and shows the generated key ${covers("result-editing › Generated key appears")}`, async () => {
    const before = Number((await second.query("SELECT count(*) AS n FROM orders"))[0].n);
    await $("aria/Add row").click();
    const last = (await Grid.rowCount()) - 1;
    await TableEditor.editCell(last, "user_id", "1");
    await TableEditor.editCell(last, "status", "pending");
    await TableEditor.editCell(last, "total", "5");
    await TableEditor.editCell(last, "created_at", "2026-01-01 00:00:00");
    await expect(TableEditor.pendingBar()).toHaveText(expect.stringContaining("1 pending change"));
    await TableEditor.submitButton().click();
    await TableEditor.pendingBar().waitForExist({ reverse: true, timeout: 15_000 });
    expect(Number((await second.query("SELECT count(*) AS n FROM orders"))[0].n)).toBe(before + 1);
    // the result is read again: the new row (highest id) is on top, with the key the database gave it
    const top = Number(await Grid.cell(0, "id"));
    await browser.waitUntil(async () => Number(await Grid.cell(0, "id")) > 20, {
      timeoutMsg: `the new row should show its generated key (top id is ${top})`,
    });
  });

  it(`deletes a row and submits it ${covers("result-editing › Delete")}`, async () => {
    const before = Number((await second.query("SELECT count(*) AS n FROM orders"))[0].n);
    await Grid.select(0, "id");
    await $("aria/Delete row").click();
    await expect(TableEditor.pendingBar()).toHaveText(expect.stringContaining("1 pending change"));
    await TableEditor.submitButton().click();
    await TableEditor.pendingBar().waitForExist({ reverse: true, timeout: 15_000 });
    expect(Number((await second.query("SELECT count(*) AS n FROM orders"))[0].n)).toBe(before - 1);
  });

  it(`offers the table chooser for a join ${covers("result-editing › Two candidates")}`, async () => {
    await Console.setText(
      "SELECT o.id AS oid, o.status, u.id AS uid, u.name FROM orders o JOIN users u ON u.id = o.user_id ORDER BY o.id LIMIT 10",
    );
    await Console.run();
    const chip = $('.//button[starts-with(@aria-label, "Editing table orders")]');
    await chip.waitForDisplayed({ timeout: 20_000 });
    await chip.click();
    await $('[role="menu"]').waitForDisplayed({ timeout: 5_000 });
    await expect($('[role="menu"]')).toHaveText(expect.stringContaining("users"));
    await browser.keys("Escape");
  });
});
