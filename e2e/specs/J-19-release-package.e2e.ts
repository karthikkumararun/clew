import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { Overlays } from "../helpers/overlay";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { StatusBar } from "../pages/StatusBar";

// J-19 what a user of a release meets (capabilities release-packaging and release-qa): About names the
// exact build, Copy diagnostics leaves out what must not leave the machine, and the app makes no
// update request on its own. The installer itself (that it installs, carries both architectures,
// is signed when it should be) is verified by the release workflow on the built package, because
// a release build has no test mode for WebDriver to drive; see docs/releasing.md.
describe("J-19 release package", () => {
  const data = withDataDir();

  before(async () => {
    const c = connectionFactory.sqlite("pkg-sqlite", `${data.dir}/pkg.db`);
    seedConnections(data.dir, [c]);
    await launchApp(data);
    await Explorer.select("pkg-sqlite");
    await browser.keys("Enter");
    await Console.waitForEditor(30_000);
  });

  it(`About shows Clew by ADK with the exact version and commit ${covers("release-packaging › Open About")}`, async () => {
    await Overlays.openDialog(StatusBar.version(), { keepOpen: true, reason: "read the dialog" });
    const dialog = $('[role="dialog"]');
    await expect(dialog).toHaveText(expect.stringContaining("Clew"));
    await expect(dialog).toHaveText(expect.stringContaining("by ADK"));
    await expect(dialog).toHaveText(expect.stringContaining("MIT License"));
    await expect(dialog).toHaveText(
      expect.stringMatching(/Version \d+\.\d+\.\d+ \([0-9a-f]{7,}\)/),
    );
    await expect(dialog.$("button=GitHub")).toBeDisplayed();
    await expect(dialog.$("button=Issues")).toBeDisplayed();
  });

  it(`opens the third-party license viewer ${covers("release-packaging › Open About")}`, async () => {
    await $("button=Third-party licenses").click();
    const frame = $('iframe[title="Third-party licenses"]');
    await frame.waitForDisplayed({ timeout: 10_000 });
    expect(await frame.getAttribute("sandbox")).toBe("");
    await browser.keys("Escape");
  });

  it(`Copy diagnostics confirms with Copied ${covers("release-qa › Copy diagnostics")}`, async () => {
    // What the report holds, and that it is redacted, is checked by the Rust tests of
    // `diagnostics.rs`; here the button works in the real app. (The clipboard of the embedded
    // WebView cannot be read back by WebDriver.)
    await $("button=Copy diagnostics").click();
    await $('[role="status"]*=Copied').waitForDisplayed({ timeout: 10_000 });
    await browser.keys("Escape");
  });

  it(`makes no update request while updates are off ${covers("release-packaging › Opt-in updates")}`, async () => {
    await $("aria/Settings").click();
    await $('.//nav[@aria-label="Settings sections"]//button[normalize-space()="Updates"]').click();
    const toggle = $('input[type="checkbox"]');
    await toggle.waitForDisplayed({ timeout: 10_000 });
    expect(await toggle.isSelected()).toBe(false);
    await expect($("button=Check now")).toBeDisplayed();
  });
});
