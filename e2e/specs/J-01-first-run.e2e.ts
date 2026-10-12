import { $, expect } from "@wdio/globals";
import { createIsolatedDb } from "../helpers/db";
import type { IsolatedDb } from "../helpers/db";
import { SERVICES } from "../helpers/db";
import { ConnectionDialog } from "../pages/ConnectionDialog";
import { Explorer } from "../pages/Explorer";
import { Welcome } from "../pages/Welcome";

// J-01 first run to a connected explorer: Welcome, New connection, Test, Save and connect.
describe("J-01 first run", () => {
  let db: IsolatedDb;
  before(async () => {
    db = await createIsolatedDb("postgres");
  });
  after(async () => {
    await db.cleanup();
  });

  it("shows the Welcome screen with no connections", async () => {
    await Welcome.newConnection().waitForDisplayed({ timeout: 30_000 });
    await expect($("aria/Explorer")).toHaveText(expect.stringContaining("No connections yet"));
  });

  it("tests and saves a PostgreSQL connection", async () => {
    await Welcome.newConnection().click();
    await ConnectionDialog.fillNetwork({
      name: "e2e-postgres",
      host: SERVICES.postgres.host,
      port: SERVICES.postgres.port,
      user: SERVICES.postgres.user,
      password: SERVICES.postgres.password,
      database: db.name,
    });
    await ConnectionDialog.testButton().click();
    await $('[role="status"]*=Connected').waitForDisplayed({ timeout: 20_000 });
    await ConnectionDialog.saveButton().click();
  });

  it("lists the connection and its schema objects in the explorer", async () => {
    await Explorer.connection("e2e-postgres").waitForDisplayed({ timeout: 20_000 });
    await $('.//footer//*[contains(text(), "Connected")]').waitForDisplayed({ timeout: 20_000 });
    await Explorer.expand("e2e-postgres");
    await Explorer.row(db.name).waitForDisplayed({ timeout: 20_000 });
    await Explorer.expand(db.name);
    await Explorer.row("public").waitForDisplayed({ timeout: 20_000 });
    await Explorer.expand("public");
    await Explorer.expand("tables");
    await Explorer.row("users").waitForDisplayed({ timeout: 20_000 });
    await Explorer.row("orders").waitForDisplayed();
  });
});
