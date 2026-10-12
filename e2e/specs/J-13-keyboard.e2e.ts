import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { withDataDir } from "../helpers/dataDir";
import { pressMod } from "../helpers/keys";
import { Explorer } from "../pages/Explorer";
import { TabStrip } from "../pages/TabStrip";

// J-13 keyboard-only operation of tabs, explorer and dialogs: no pointer after the app starts.
describe("J-13 keyboard only", () => {
  const data = withDataDir();

  before(async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("keys-sqlite", `${data.dir}/keys.db`)]);
    await launchApp(data);
  });

  it("moves through the explorer with arrows and opens a console with Enter", async () => {
    await browser.execute(() => document.querySelector<HTMLElement>('[role="tree"]')?.focus());
    // arrow down to the connection (the first row may be its group)
    for (let i = 0; i < 3; i++) {
      await browser.keys("ArrowDown");
      const selected = await $('[role="treeitem"][aria-selected="true"]');
      if ((await selected.getText()).includes("keys-sqlite")) break;
    }
    await expect($('[role="treeitem"][aria-selected="true"]')).toHaveText(
      expect.stringContaining("keys-sqlite"),
    );
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 20_000 });
    await expect(TabStrip.tabs()).toBeElementsArrayOfSize(1);
  });

  it("opens a second console with the shortcut and switches tabs with the arrow keys", async () => {
    await pressMod("t");
    await browser.waitUntil(async () => (await TabStrip.tabs()).length === 2, {
      timeoutMsg: "second console expected",
    });
    // focus the strip's active tab, then ArrowLeft activates the first tab
    await browser.execute(() =>
      document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus(),
    );
    await browser.keys("ArrowLeft");
    const first = (await TabStrip.tabs())[0];
    await expect(first).toHaveAttribute("aria-selected", "true");
  });

  it("opens Settings with the shortcut and closes it with Escape, returning focus", async () => {
    await pressMod(",");
    const dialog = await $('[role="dialog"]');
    await dialog.waitForDisplayed({ timeout: 10_000 });
    await browser.keys("Escape");
    await dialog.waitForExist({ reverse: true, timeout: 10_000 });
    const tag = await browser.execute(() => document.activeElement?.tagName ?? "");
    expect(tag).not.toBe("BODY");
  });

  it("leaves the explorer tree reachable by Tab", async () => {
    await expect(Explorer.tree()).toBeExisting();
    expect(await (await Explorer.tree()).getAttribute("tabindex")).toBe("0");
  });
});
