import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { pressKey, pressMod } from "../helpers/keys";
import { selectedText, selectionVisibility } from "../helpers/selection";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";

// J-25 selecting text in the console (spec: sql-console › Text selection). The selection must
// not only exist, it must be visible: an opaque tint on the current statement once painted over
// it, so every selection looked like nothing had happened. (Mouse drags cannot be produced by the
// embedded WebDriver, but they draw through the same layer, so the visibility check covers them.)
describe("J-25 editor selection", () => {
  const data = withDataDir();
  const mac = process.platform === "darwin";
  const LINE2 = "SELECT id, name FROM users";

  before(async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("sel-sqlite", `${data.dir}/sel.db`)]);
    await launchApp(data);
    await Explorer.select("sel-sqlite");
    await browser.keys("Enter");
    await Console.waitForEditor(30_000);
    await Console.setText(`SELECT 1;\n${LINE2}`);
  });

  const expectVisible = async () => {
    // Compared as a whole so a failure names why the selection is hidden.
    expect(await selectionVisibility()).toEqual({ visible: true, reason: "" });
  };

  it(`selects to the line start and shows it ${covers("sql-console › Text selection")}`, async () => {
    // The caret is at the end of line 2 after typing.
    if (mac) await pressKey("ArrowLeft", { meta: true, shift: true });
    else await pressKey("Home", { shift: true });
    expect(await selectedText()).toBe(LINE2);
    await expectVisible();
  });

  it(`selects to the line end and shows it ${covers("sql-console › Text selection")}`, async () => {
    await browser.keys("ArrowLeft"); // collapses to the start of the line
    if (mac) await pressKey("ArrowRight", { meta: true, shift: true });
    else await pressKey("End", { shift: true });
    expect(await selectedText()).toBe(LINE2);
    await expectVisible();
  });

  it(`selects everything and shows it ${covers("sql-console › Text selection")}`, async () => {
    await pressMod("a");
    expect(await selectedText()).toContain("SELECT 1;");
    await expectVisible();
  });

  it(`a selection runs alone ${covers("sql-console › Text selection")}`, async () => {
    await browser.keys("ArrowRight");
    if (mac) await pressKey("ArrowLeft", { meta: true, shift: true });
    else await pressKey("Home", { shift: true });
    await Console.run();
    await expect($("aria/Result")).toBeDisplayed();
  });
});
