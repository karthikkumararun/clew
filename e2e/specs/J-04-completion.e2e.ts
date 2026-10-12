import { $, $$, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import type { IsolatedDb } from "../helpers/db";
import { openShopConsole } from "../helpers/fixtures";
import { Console } from "../pages/Console";

// J-04 schema-aware completion after the snapshot loads.
describe("J-04 completion", () => {
  const data = withDataDir();
  let db: IsolatedDb;
  before(async () => {
    ({ db } = await openShopConsole(data));
  });
  after(async () => {
    await db.cleanup();
  });

  const options = async () => (await $$(".cm-tooltip-autocomplete [role=option]")).length;
  const optionText = () => $(".cm-tooltip-autocomplete").getText();

  it(`lists the columns of an aliased table after the dot ${covers("sql-console › Alias columns")}`, async () => {
    await Console.setText("SELECT * FROM orders o WHERE o.");
    await browser.waitUntil(async () => (await options()) > 0, {
      timeout: 15_000,
      timeoutMsg: "completion popup expected",
    });
    const text = await optionText();
    for (const col of ["status", "total", "notes", "user_id"]) expect(text).toContain(col);
  });

  it(`offers a table created in the console without reconnecting ${covers("sql-console › Stale schema")}`, async () => {
    await browser.keys("Escape");
    await Console.setText("CREATE TABLE e2e_fresh (id integer)");
    await Console.run();
    await Console.openTab("Output");
    await expect($('[aria-label="Output"]'))
      .toHaveText(expect.stringContaining("e2e_fresh"), { wait: 10_000 })
      .catch(() => {});
    await Console.setText("SELECT * FROM e2e_fr");
    await browser.waitUntil(
      async () => (await options()) > 0 && (await optionText()).includes("e2e_fresh"),
      {
        timeout: 20_000,
        timeoutMsg: "e2e_fresh should be offered after the snapshot refresh",
      },
    );
  });
});
