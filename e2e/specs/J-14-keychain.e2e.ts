import { readFileSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { invokeCommand } from "../helpers/tauri";
import { ConnectionDialog } from "../pages/ConnectionDialog";
import { Explorer } from "../pages/Explorer";
import { Welcome } from "../pages/Welcome";

// J-14 real OS keychain round trip under the test service name `Clew-e2e` (macOS and Windows).
// The app runs with CLEW_E2E_KEYCHAIN=1 (scripts/qa-e2e.ts), so its secret store is the real
// keychain, and the checks read the item back through the OS, not through the app's own store.
const NAME = "keychain-e2e";
const PASSWORD = "keychain-e2e-password";

describe("J-14 real keychain", function () {
  const data = withDataDir();
  let account = "";

  before(function () {
    if (process.platform === "linux") return this.skip(); // no keychain in a headless Linux runner
  });

  after(async () => {
    // never leave an item behind, whatever happened above
    if (account) await invokeCommand("e2e_keychain_delete", { account }).catch(() => {});
  });

  const stored = () => invokeCommand<string | null>("e2e_keychain_get", { account });

  it(`stores a saved password in the OS keychain under the test service ${covers("e2e-testing › Keychain round trip")}`, async () => {
    await Welcome.newConnection().waitForDisplayed({ timeout: 30_000 });
    await Welcome.newConnection().click();
    // Nothing listens on port 1: the connection is saved, the connect attempt fails, and that is fine.
    await ConnectionDialog.fillNetwork({
      name: NAME,
      host: "127.0.0.1",
      port: 1,
      user: "nobody",
      password: PASSWORD,
      database: "none",
    });
    await ConnectionDialog.saveButton().click();
    await Explorer.connection(NAME).waitForDisplayed({ timeout: 20_000 });

    const file = JSON.parse(readFileSync(join(data.dir, "connections.json"), "utf8")) as {
      connections: { id: string; name: string }[];
    };
    account = `${file.connections.find((c) => c.name === NAME)!.id}:password`;
    await browser.waitUntil(async () => (await stored()) === PASSWORD, {
      timeoutMsg: "the password should be in the OS keychain",
    });
  });

  it("keeps the password out of connections.json", () => {
    expect(readFileSync(join(data.dir, "connections.json"), "utf8")).not.toContain(PASSWORD);
  });

  it("finds the password again after a restart", async () => {
    await launchApp(data);
    await Explorer.connection(NAME).waitForDisplayed({ timeout: 20_000 });
    expect(await stored()).toBe(PASSWORD);
  });

  it(`removes the item when the connection is deleted ${covers("e2e-testing › Keychain round trip")}`, async () => {
    await Explorer.select(NAME);
    await browser.keys("Delete");
    // by role and exact name: "Delete connection" (the dialog title) also matches aria/Delete
    const confirm = $('.//*[@role="dialog"]//button[normalize-space()="Delete"]');
    await confirm.waitForDisplayed({ timeout: 10_000 });
    await confirm.click();
    await Explorer.connection(NAME).waitForExist({ reverse: true, timeout: 10_000 });
    await browser.waitUntil(async () => (await stored()) === null, {
      timeoutMsg: "the keychain item should be gone",
    });
  });
});
