import { $, $$, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { TabStrip } from "../pages/TabStrip";

// J-26 workspaces (the workspaces capability): consoles saved into named workspaces for two connections of
// different environments, switching between them, and a real relaunch that brings back the open
// workspace without running anything.
describe("J-26 workspaces", () => {
  const data = withDataDir();
  const A = "SELECT 'staging work' AS a";
  const B = "SELECT 'production work' AS b";

  const switcher = () => $('//button[@aria-haspopup="menu"][contains(., "Workspace")]');
  const openMenu = async () => {
    await switcher().click();
    await $('[role="menu"][aria-label="Workspaces"]').waitForDisplayed({ timeout: 10_000 });
  };
  const choose = async (label: string) => {
    await $(
      `//*[@role="menu"][@aria-label="Workspaces"]//*[@role="menuitem"][contains(., "${label}")]`,
    ).click();
  };
  const saveAs = async (name: string) => {
    await openMenu();
    await choose("Save workspace as");
    const input = await $("#workspace-name");
    await input.waitForDisplayed({ timeout: 10_000 });
    await input.setValue(name);
    await $('//*[@role="dialog"]//button[normalize-space()="Save"]').click();
    await input.waitForExist({ reverse: true, timeout: 10_000 });
  };

  before(async () => {
    seedConnections(data.dir, [
      connectionFactory.sqlite("stg-sqlite", `${data.dir}/stg.db`, "staging"),
      connectionFactory.sqlite("prod-sqlite", `${data.dir}/prod.db`, "production"),
    ]);
    await launchApp(data);
  });

  it("saves a console of a staging connection as a workspace", async () => {
    await Explorer.select("stg-sqlite");
    await browser.keys("Enter");
    await Console.waitForEditor(30_000);
    await Console.setText(A);
    await saveAs("Staging checks");
    await expect(switcher()).toHaveText(expect.stringContaining("Staging checks"));
  });

  it(`starts a second, empty workspace and fills it from a production connection ${covers("workspaces › Starting a workspace")}`, async () => {
    await openMenu();
    await choose("New workspace");
    const input = await $("#workspace-name");
    await input.waitForDisplayed({ timeout: 10_000 });
    await input.setValue("Prod checks");
    await $('//*[@role="dialog"]//button[normalize-space()="Create"]').click();
    await input.waitForExist({ reverse: true, timeout: 10_000 });
    await expect(switcher()).toHaveText(expect.stringContaining("Prod checks"));
    await expect(TabStrip.tabs()).toBeElementsArrayOfSize(0);
    await Explorer.select("prod-sqlite");
    await browser.keys("Enter");
    await Console.waitForEditor(30_000);
    await Console.setText(B);
  });

  it(`lists them under their environments ${covers("workspaces › Environment grouping")}`, async () => {
    await openMenu();
    const headings = await $$(
      '//*[@role="menu"][@aria-label="Workspaces"]//*[@role="menuitem"]',
    ).map((e) => e.getText());
    const text = headings.join("|");
    expect(text).toContain("Staging");
    expect(text).toContain("Production");
    expect(text.indexOf("Staging")).toBeLessThan(text.indexOf("Production"));
    await browser.keys("Escape");
  });

  it(`switches between workspaces without losing text ${covers("workspaces › Switching workspaces")}`, async () => {
    await openMenu();
    await choose("Staging checks");
    await browser.waitUntil(async () => (await Console.text()) === A, {
      timeoutMsg: `staging console expected, shows "${await Console.text()}"`,
    });
    await expect(TabStrip.tabs()).toBeElementsArrayOfSize(1);
    await openMenu();
    await choose("Prod checks");
    await browser.waitUntil(async () => (await Console.text()) === B, {
      timeoutMsg: `production console expected, shows "${await Console.text()}"`,
    });
  });

  it(`relaunching restores the open workspace and runs nothing ${covers("workspaces › Safe restore", "app-shell › Persisted workspace state")}`, async () => {
    await launchApp(data);
    await Console.waitForEditor(30_000);
    await browser.waitUntil(async () => (await Console.text()) === B, {
      timeoutMsg: `Prod checks should be open again, shows "${await Console.text()}"`,
    });
    await expect(switcher()).toHaveText(expect.stringContaining("Prod checks"));
    // Restoring is passive: nothing has run, so there is no result yet.
    await expect($("aria/Run a statement to see its rows here.")).toBeDisplayed();
  });
});
