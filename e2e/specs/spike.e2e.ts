import { browser, $, expect } from "@wdio/globals";

// Task 1.1 spike: launch, find by accessible name, click, type, screenshot, relaunch same data dir.
describe("spike", () => {
  it("launches, finds by name, clicks, types, saves and screenshots", async () => {
    const newConn = await $("aria/New connection");
    await newConn.waitForDisplayed({ timeout: 20_000 });
    await newConn.click();
    await $("aria/Test connection").waitForDisplayed();
    await $("aria/Name").setValue("spike-connection");
    await browser.saveScreenshot("e2e/artifacts/spike-1.png");
    await $("aria/Cancel").click();
  });

  it("relaunches with the same data dir", async () => {
    await browser.reloadSession();
    await $("aria/New connection").waitForDisplayed({ timeout: 20_000 });
    await expect(browser).toHaveTitle("Clew");
  });
});
