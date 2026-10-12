import { $, browser } from "@wdio/globals";
import { launchApp, waitForShell } from "../helpers/app";
import { connectionFactory, seedConnections } from "../helpers/connections";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { expectRegion } from "../helpers/metrics";
import { Explorer } from "../pages/Explorer";

// D-01 rendered metrics: the real app's boxes and radii against design/metrics.json, at the
// reference window size (spec: design-conformance › Machine-readable design metrics).

describe("D-01 rendered metrics", () => {
  const data = withDataDir();

  before(async () => {
    seedConnections(data.dir, [connectionFactory.sqlite("metrics-db", `${data.dir}/m.db`)]);
    await waitForShell();
    await launchApp(data);
    await browser.setWindowSize(1440, 900);
  });

  it(`toolbar, status bar and sidebar have the canvas sizes ${covers("design-conformance › Default layout is measured, not assumed")}`, async () => {
    await expectRegion("toolbar");
    await expectRegion("status-bar");
    await expectRegion("sidebar");
  });

  it("tree rows are 24px", async () => {
    await Explorer.row("metrics-db").waitForDisplayed({ timeout: 10_000 });
    await expectRegion("tree-row");
  });

  it("the tab strip is 36px once a console is open", async () => {
    await Explorer.select("metrics-db");
    await browser.keys("Enter");
    await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
    await expectRegion("tab-strip");
  });

  it("dialogs have a 12px radius and 34px buttons", async () => {
    await Explorer.newConnectionButton().click();
    await $('[role="dialog"]').waitForDisplayed({ timeout: 10_000 });
    await expectRegion("dialog");
    await expectRegion("dialog-button");
    await browser.keys("Escape");
  });
});
