import { $, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import type { IsolatedDb } from "../helpers/db";
import { LONG_QUERY } from "../helpers/dialect";
import { openShopConsole } from "../helpers/fixtures";
import { Console } from "../pages/Console";
import { Grid } from "../pages/Grid";

// J-03 console: run statement, multi-result script, error underlined at its position, cancel
// a long query, history entry.
describe("J-03 console", () => {
  const data = withDataDir();
  let db: IsolatedDb;
  before(async () => {
    ({ db } = await openShopConsole(data));
  });
  after(async () => {
    await db.cleanup();
  });

  it(`runs the current statement and shows its rows ${covers("sql-console › Run current statement")}`, async () => {
    await Console.setText("SELECT id, name FROM users ORDER BY id LIMIT 5");
    await Console.run();
    await browser.waitUntil(async () => (await Grid.rowCount()) === 5, {
      timeoutMsg: "5 rows expected",
    });
    expect(await Grid.cell(0, "name")).toBe("Ada Lovelace");
    expect(await Grid.cell(1, "name")).toBe("Zoë Müller");
  });

  it(`shows one sub-tab per result of a script ${covers("sql-console › Run script with several results")}`, async () => {
    await Console.setText("SELECT 1 AS a;\nSELECT 2 AS b;\nSELECT 3 AS c;");
    await Console.runScript();
    await browser.waitUntil(async () => (await Console.resultSets()).length === 3, {
      timeoutMsg: "three result sub-tabs expected",
    });
  });

  it(`underlines the error position ${covers("sql-console › Unknown column")}`, async function () {
    // The scenario is about PostgreSQL's error position; SQLite reports none.
    if (db.dialect !== "postgres") return this.skip();
    await Console.setText("SELECT o.carrier FROM orders o");
    await Console.run();
    await $('[aria-label="Output"]').waitForDisplayed({ timeout: 10_000 });
    await expect($('[aria-label="Output"]')).toHaveText(expect.stringContaining("carrier"));
    await browser.waitUntil(async () => (await Console.errorRanges()).length > 0, {
      timeoutMsg: "an underlined error range expected",
    });
  });

  it(`cancels a long query ${covers("sql-console › Cancel")}`, async () => {
    await Console.setText(LONG_QUERY[db.dialect]);
    await Console.run();
    await browser.pause(1500);
    await Console.cancel();
    await expect($('[aria-label="Output"]')).toHaveText(expect.stringContaining("Cancelled"), {
      wait: 10_000,
    });
  });

  it(`records statements in history ${covers("query-history › Successful run recorded")}`, async () => {
    await Console.openTab("History");
    await expect($('[aria-label="History"]')).toHaveText(expect.stringContaining("FROM users"));
  });
});
