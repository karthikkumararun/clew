import { $, browser, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { connectServer } from "../helpers/db";
import type { Db, IsolatedDb } from "../helpers/db";
import { openShopConsole } from "../helpers/fixtures";
import { Console } from "../pages/Console";
import { Safeguards } from "../pages/Safeguards";

// J-08 production safeguards: read-only block, switch to read-write, write confirmation, typed
// confirmation for DELETE without WHERE.
describe("J-08 safeguards", () => {
  const data = withDataDir();
  let db: IsolatedDb;
  let connection: string;
  let second: Db;
  before(async () => {
    ({ db, connection } = await openShopConsole(data, "postgres", "production"));
    second = await connectServer("postgres", db.name);
  });
  after(async () => {
    await second.close();
    await db.cleanup();
  });
  const status = async (id: number) =>
    (await second.query(`SELECT status FROM orders WHERE id = ${id}`))[0].status;

  it(`starts read-only and blocks a write ${covers("production-safeguards › Write in a read-only console")}`, async () => {
    await expect(Safeguards.badge()).toHaveText(expect.stringContaining("READ-ONLY"));
    const before = await status(1);
    await Console.setText("UPDATE orders SET status = 'hacked' WHERE id = 1");
    await Console.run();
    await expect($('[aria-label="Output"]')).toHaveText(expect.stringContaining("read-only"), {
      wait: 10_000,
    });
    expect(await status(1)).toBe(before);
  });

  it(`switches this session to read-write after confirmation ${covers("production-safeguards › Toggle")}`, async () => {
    await Safeguards.badge().click();
    await Safeguards.switchItem().click();
    await Safeguards.dialogButton("Switch to read-write").click();
    await expect(Safeguards.badge()).toHaveText(expect.stringContaining("READ-WRITE"), {
      wait: 10_000,
    });
  });

  it(`asks before running a write and runs it only after Confirm ${covers("production-safeguards › Confirm a write")}`, async () => {
    await Console.setText("UPDATE orders SET status = 'shipped' WHERE id = 1");
    await Console.run();
    await Safeguards.dialog().waitForDisplayed({ timeout: 10_000 });
    await expect(Safeguards.target()).toHaveText(
      expect.stringContaining(`${connection} · Production`),
    );
    await expect(Safeguards.statements()).toHaveText(expect.stringContaining("UPDATE orders"));
    await expect(Safeguards.statements()).toHaveText(expect.stringContaining("1 row"));
    expect(await status(1)).not.toBe("shipped"); // nothing ran yet
    await Safeguards.dialogButton("Confirm").click();
    // production starts in manual-commit mode: the change is in an open transaction until Commit
    await $('.//button[normalize-space()="Commit"]').waitForDisplayed({ timeout: 10_000 });
    expect(await status(1)).not.toBe("shipped");
    await $('.//button[normalize-space()="Commit"]').click();
    await browser.waitUntil(async () => (await status(1)) === "shipped", {
      timeoutMsg: "the update should run after Confirm",
    });
  });

  it(`requires typing the connection name for DELETE without WHERE ${covers("production-safeguards › DELETE without WHERE on production")}`, async () => {
    await Console.setText("DELETE FROM shipments");
    await Console.run();
    await Safeguards.typedField().waitForDisplayed({ timeout: 10_000 });
    await expect(Safeguards.dialogButton("Run")).toBeDisabled();
    await Safeguards.typedField().setValue("wrong-name");
    await expect(Safeguards.dialogButton("Run")).toBeDisabled();
    await Safeguards.typedField().setValue(connection);
    await expect(Safeguards.dialogButton("Run")).toBeEnabled();
    await Safeguards.dialogButton("Cancel").click();
    const [{ n }] = await second.query("SELECT count(*)::int AS n FROM shipments");
    expect(n).toBe(120); // nothing deleted
  });
});
