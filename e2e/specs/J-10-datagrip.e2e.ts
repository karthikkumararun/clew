import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { $, expect } from "@wdio/globals";
import { covers } from "../helpers/covers";
import { withDataDir } from "../helpers/dataDir";
import { Exchange } from "../pages/Exchange";
import { Explorer } from "../pages/Explorer";

// J-10 DataGrip import from a fixture folder, with consoles appearing under Scripts. The app reads
// e2e/fixtures/datagrip instead of the real DataGrip settings (CLEW_E2E_DATAGRIP_ROOT).
describe("J-10 DataGrip import", () => {
  const data = withDataDir();
  before(async () => {
    await Explorer.panel().waitForDisplayed({ timeout: 30_000 });
  });

  it(`lists the data sources found in the fixture ${covers("connection-management › Detect DataGrip", "connection-management › Unsupported driver")}`, async () => {
    await Exchange.open("import");
    const dialog = await $('[role="dialog"]');
    await expect(dialog).toHaveText(expect.stringContaining("DataGrip 2026.1"), { wait: 15_000 });
    await expect(dialog).toHaveText(expect.stringContaining("analytics-prod"));
    await expect(dialog).toHaveText(expect.stringContaining("billing-mysql"));
    await expect(dialog).toHaveText(expect.stringContaining("old-cassandra"));
    await expect(dialog).toHaveText(expect.stringContaining("Driver not available"));
  });

  it(`imports the chosen connections with their consoles ${covers("connection-management › Map drivers and settings", "connection-management › Consoles follow their connection")}`, async () => {
    for (const name of ["analytics-prod", "billing-mysql"]) {
      const box = await Exchange.candidate(name);
      if (!(await box.isSelected())) await box.click();
    }
    await $('.//*[@role="dialog"]//button[starts-with(normalize-space(), "Import ")]').click();
    await Explorer.connection("analytics-prod").waitForDisplayed({ timeout: 20_000 });
    await Explorer.connection("billing-mysql").waitForDisplayed();
    // the four consoles are copied into a Scripts folder named after the connection
    const dir = join(data.dir, "Scripts", "analytics-prod");
    expect(readdirSync(dir).filter((f) => f.endsWith(".sql"))).toHaveLength(4);
    expect(existsSync(join(data.dir, "Scripts", "billing-mysql"))).toBe(false); // it had none
  });
});
