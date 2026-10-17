import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { expectOverlayIntact } from "../helpers/overlay";
import { withDataDir } from "../helpers/dataDir";
import { createIsolatedDb } from "../helpers/db";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { Grid } from "../pages/Grid";
import { Palette } from "../pages/Palette";
import { TabStrip } from "../pages/TabStrip";
import { copyFileSync } from "node:fs";

// J-16 the command palette: search objects across connections, open a table, open it in a console,
// connect on open, run an action. Two SQLite copies of the `shop` seed stand in for two
// connections, so no containers are needed.
describe("J-16 command palette", () => {
  const data = withDataDir();

  const seeded = async (name: string, env: "development" | "staging") => {
    const lite = await createIsolatedDb("sqlite");
    const path = `${data.dir}/${name}.sqlite`;
    copyFileSync(lite.name, path);
    await lite.cleanup();
    return connectionFactory.sqlite(name, path, env);
  };

  before(async () => {
    seedConnections(data.dir, [
      await seeded("dev-sqlite", "development"),
      await seeded("staging-sqlite", "staging"),
    ]);
    await launchApp(data);
    // Connecting indexes a connection; do it for both, then restart so neither is connected.
    for (const name of ["dev-sqlite", "staging-sqlite"]) {
      await Explorer.select(name);
      await browser.keys("Enter");
      await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
    }
    await browser.waitUntil(
      async () => {
        await Palette.open();
        await Palette.type("orders");
        const texts = await Palette.rowTexts();
        await browser.keys("Escape");
        return (
          texts.some((t) => t.includes("dev-sqlite")) &&
          texts.some((t) => t.includes("staging-sqlite"))
        );
      },
      { timeout: 30_000, interval: 1000, timeoutMsg: "both connections should be indexed" },
    );
    await launchApp(data);
  });

  it(`opens on Mod+K with the input focused and closes on Esc ${covers("command-palette › Open and close")}`, async () => {
    await Palette.open();
    const focused = await browser.execute(
      () => document.activeElement?.getAttribute("role") === "combobox",
    );
    expect(focused).toBe(true);
    await expect(Palette.scope("All")).toHaveAttribute("aria-selected", "true");
    await browser.keys("Escape");
    await expect(Palette.dialog()).not.toBeDisplayed();
  });

  it(`finds tables of both connections and ranks the prefix first (spec: command-palette › Search "ord")`, async () => {
    await Palette.open();
    await Palette.type("ord");
    await browser.waitUntil(async () => (await Palette.rowTexts()).length >= 2);
    const texts = await Palette.rowTexts();
    expect(texts[0]).toMatch(/^order/);
    expect(texts.filter((t) => t.startsWith("orders")).length).toBeGreaterThanOrEqual(2);
    expect(texts.some((t) => t.includes("dev-sqlite"))).toBe(true);
    expect(texts.some((t) => t.includes("staging-sqlite"))).toBe(true);
    await browser.keys("Escape");
  });

  for (const width of [1440, 880]) {
    it(`stays inside the ${width}px window, uncovered and unclipped ${covers("command-palette › Palette is fully visible")}`, async () => {
      await browser.setWindowSize(width, 700);
      await browser.pause(300);
      await Palette.open();
      await Palette.type("o");
      await browser.waitUntil(async () => (await Palette.rowTexts()).length > 0);
      await expectOverlayIntact('[role="dialog"][aria-label="Command palette"]');
      await browser.keys("Escape");
      await browser.setWindowSize(1440, 900);
    });
  }

  it(`says when nothing matches ${covers("command-palette › Nothing found")}`, async () => {
    await Palette.open();
    await Palette.type("zzzzqq");
    await $('[role="status"]*=No matches').waitForDisplayed({ timeout: 10_000 });
    await browser.keys("Escape");
  });

  it(`connects a disconnected connection and opens the table ${covers("command-palette › Disconnected connection")}`, async () => {
    await Palette.open();
    await Palette.type("orders");
    await browser.waitUntil(async () =>
      (await Palette.rowTexts()).some((t) => t.includes("staging-sqlite")),
    );
    const options = await Palette.options();
    const texts = await Palette.rowTexts();
    await options[texts.findIndex((t) => t.includes("staging-sqlite"))].click();
    await browser.waitUntil(async () => (await Grid.rowCount()) > 0, {
      timeout: 30_000,
      timeoutMsg: "the table should open with rows",
    });
    await expect(Palette.dialog()).not.toBeDisplayed();
  });

  it(`Alt+Enter opens a console with the starter query, not run ${covers("command-palette › Open in console")}`, async () => {
    const before = (await TabStrip.tabs()).length;
    await Palette.open();
    await Palette.type("orders");
    await browser.waitUntil(async () => (await Palette.rowTexts()).length > 0);
    await Palette.altEnter();
    await browser.waitUntil(async () => (await TabStrip.tabs()).length === before + 1);
    await browser.waitUntil(async () => (await Console.text()).startsWith("SELECT * FROM"), {
      timeoutMsg: `the console should hold the starter query, holds "${await Console.text()}"`,
    });
    expect(await Console.text()).toMatch(/orders.* LIMIT 100/);
  });

  it(`runs an action by name ${covers("command-palette › Run an action")}`, async () => {
    await Palette.open();
    await Palette.scope("Actions").click();
    await Palette.type("new conn");
    await browser.waitUntil(async () => (await Palette.rowTexts()).length > 0);
    await browser.keys("Enter");
    await $('[role="dialog"]*=New connection').waitForDisplayed({ timeout: 10_000 });
    await browser.keys("Escape");
  });
});
