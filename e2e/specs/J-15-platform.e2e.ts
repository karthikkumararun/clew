import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { createIsolatedDb } from "../helpers/db";
import { pressMod } from "../helpers/keys";
import { invokeCommand } from "../helpers/tauri";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { Grid } from "../pages/Grid";
import { StatusBar } from "../pages/StatusBar";

// J-15 platform checks that differ per OS: title bar and toolbar layout, the Mod key mapping and
// file paths with spaces and non-ASCII characters (spec: e2e-testing › Native platform smoke checks).
describe("J-15 platform", () => {
  const data = withDataDir();
  const mac = process.platform === "darwin";

  it(`lays out the title bar and toolbar for the platform ${covers("e2e-testing › Native platform smoke checks")}`, async () => {
    await launchApp(data);
    const box = await browser.execute(() => {
      const r = (el: Element | null) => {
        const b = el?.getBoundingClientRect();
        return b ? { x: b.x, y: b.y, width: b.width, height: b.height } : null;
      };
      return {
        header: r(document.querySelector("header")),
        brand: r(document.querySelector("header > div")),
        window: { width: window.innerWidth },
      };
    });
    expect(box.header).not.toBeNull();
    expect(box.header!.y).toBe(0);
    expect(box.header!.height).toBe(44); // --h-titlebar
    expect(box.header!.width).toBe(box.window.width);
    // macOS reserves room for the traffic lights (78px); Windows and Linux start at 16px
    expect(box.brand!.x).toBe(mac ? 78 : 16);
  });

  it(`opens Settings with the platform's Mod key ${covers("e2e-testing › Platform shortcut mapping")}`, async () => {
    // Go-to-anything (Mod+K) arrives with add-command-palette; Settings is bound to Mod+, today.
    await $("aria/Explorer").click();
    await pressMod(",");
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10_000 });
    await expect($('[role="dialog"]')).toHaveText(expect.stringContaining("Settings"));
    await browser.keys("Escape");
    await $('[role="dialog"]').waitForExist({ reverse: true, timeout: 10_000 });
  });

  it("shows the shortcut with the platform's own symbols", async () => {
    await expect($("main")).toHaveText(expect.stringContaining(mac ? "⌘," : "Ctrl+,"));
  });

  it("opens a database whose path has spaces and non-ASCII characters", async () => {
    const lite = await createIsolatedDb("sqlite");
    const dir = join(data.dir, "..", "Mes données été 日本");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "boutique é.sqlite");
    copyFileSync(lite.name, path);
    await lite.cleanup();
    seedConnections(data.dir, [connectionFactory.sqlite("unicode-path", path)]);
    await launchApp(data);
    await Explorer.select("unicode-path");
    await browser.keys("Enter");
    await Console.waitForEditor(30_000);
    await Console.setText("SELECT count(*) AS n FROM users");
    await Console.run();
    await browser.waitUntil(async () => (await Grid.rowCount()) === 1, {
      timeoutMsg: "one result row expected",
    });
    expect(Number(await Grid.cell(0, "n"))).toBeGreaterThan(0);
  });

  it(`builds the diagnostics report in the real app ${covers("release-qa › Copy diagnostics")}`, async () => {
    const report = await invokeCommand<string>("diagnostics_bundle", { connectionId: null });
    for (const part of [
      "Clew diagnostics",
      "Version:",
      "OS:",
      "WebView:",
      "Drivers:",
      "Log (last 200",
    ]) {
      expect(report).toContain(part);
    }
    expect(report).toContain("- PostgreSQL");
    // the temporary data directory is under the home directory on macOS and Linux
    expect(report).not.toContain(data.dir);
  });

  it("opens About from the version in the status bar and shows Copy diagnostics", async () => {
    await StatusBar.version().click();
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10_000 });
    await expect($("aria/Copy diagnostics")).toBeDisplayed();
    await browser.keys("Escape");
  });
});
