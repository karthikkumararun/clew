import { $, $$, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { launchApp } from "../helpers/app";
import { openSecond } from "../helpers/dialect";
import type { Db, IsolatedDb } from "../helpers/db";
import { openShopConsole } from "../helpers/fixtures";
import { pressMod } from "../helpers/keys";
import { seedUiState } from "../helpers/uiState";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";

// J-23 the Sessions panel: a console leaves a transaction open, the panel and status bar flag it
// as idle (threshold shortened to the 1 minute minimum), Roll back from the panel, attach to
// another session, and the isolation level.
describe("J-23 session manager", function () {
  this.timeout(300_000);
  const data = withDataDir();
  let db: IsolatedDb;
  let second: Db;
  let connection: string;

  const sessionRow = (state?: string) =>
    $(`.//*[@role="treeitem"][@aria-level="2"]${state ? `[@data-state="${state}"]` : ""}`);
  const toolbar = (label: string) => $(`[aria-label="Sessions actions"] [aria-label="${label}"]`);

  before(async () => {
    ({ db, connection } = await openShopConsole(data));
    second = await openSecond(db);
    // the local threshold is 15 minutes; 1 minute is the smallest the settings allow
    seedUiState(data.dir, { "sessions.idleMinutes.local": "1" });
    await launchApp(data);
    await Explorer.select(connection);
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
    await $('.//button[starts-with(normalize-space(.), "Tx:")]').click();
    await $('[role="menuitem"]*=Manual').click();
    await $('.//button[starts-with(normalize-space(.), "Tx: Manual")]').waitForDisplayed({
      timeout: 10_000,
    });
  });
  after(async () => {
    await second.close();
    await db.cleanup();
  });

  it(`lists the console's session and shows its open transaction ${covers("session-manager › Open the panel", "session-manager › Open transaction")}`, async () => {
    await Console.setText("UPDATE orders SET notes = 'idle-tx' WHERE id = 3");
    await Console.run();
    await $('.//button[starts-with(normalize-space(.), "Commit")]').waitForDisplayed({
      timeout: 10_000,
    });
    await pressMod("s", { alt: true });
    await $('[aria-label="Sessions by connection"]').waitForDisplayed({ timeout: 10_000 });
    const row = await sessionRow("in_transaction");
    await row.waitForDisplayed({ timeout: 10_000 });
    await expect(row).toHaveText(expect.stringContaining("1 statement"));
  });

  it(`flags the session once it has been idle in the transaction ${covers("session-manager › Threshold reached")}`, async () => {
    await $('[aria-label="Idle in transaction"]').waitForDisplayed({ timeout: 150_000 });
    await expect($('.//footer//button[contains(., "idle in transaction")]')).toBeDisplayed();
  });

  it(`rolls the transaction back from the panel`, async () => {
    await (await sessionRow("in_transaction")).click();
    await toolbar("Roll back").click();
    await sessionRow("idle").waitForDisplayed({ timeout: 15_000 });
    const [row] = await second.query("SELECT notes FROM orders WHERE id = 3");
    expect(row.notes).not.toBe("idle-tx");
    await $('[aria-label="Idle in transaction"]').waitForDisplayed({
      reverse: true,
      timeout: 10_000,
    });
  });

  it(`attaches the console to a new session`, async () => {
    await (await sessionRow()).click();
    await $("button=Attach to…").click();
    await $('[role="menuitem"]*=New session').click();
    await sessionRow("idle").waitForDisplayed({ timeout: 15_000 });
    await Console.setText("SELECT 1 AS one");
    await Console.run();
    await $('[role="grid"], [data-testid="data-grid-canvas"]').waitForDisplayed({
      timeout: 15_000,
    });
  });

  it(`changes the isolation level ${covers("driver-framework › Set isolation")}`, async function () {
    if (db.dialect === "sqlite") return this.skip();
    await (await sessionRow()).click();
    await $('.//button[starts-with(@aria-label, "Isolation level:")]').click();
    await $('[role="menuitem"]*=SERIALIZABLE').click();
    await $('.//button[@aria-label="Isolation level: SERIALIZABLE"]').waitForDisplayed({
      timeout: 10_000,
    });
  });

  it("closes the panel with Hide", async () => {
    await $("aria/Hide panel").click();
    await expect($('[aria-label="Sessions by connection"]')).not.toBeDisplayed();
    expect((await $$('[aria-label="Sessions by connection"]')).length).toBe(0);
  });
});
