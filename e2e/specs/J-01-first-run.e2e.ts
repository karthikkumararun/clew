import { $, expect } from "@wdio/globals";
import { SERVICES, createIsolatedDb } from "../helpers/db";
import type { IsolatedDb, ServerDialect } from "../helpers/db";
import { journeyDialect, tablesPath } from "../helpers/dialect";
import { covers } from "../helpers/covers";
import { ConnectionDialog } from "../pages/ConnectionDialog";
import { Explorer } from "../pages/Explorer";
import { Welcome } from "../pages/Welcome";

// J-01 first run to a connected explorer: Welcome, New connection, Test, Save and connect.
describe("J-01 first run", () => {
  const dialect = journeyDialect();
  const name = `e2e-${dialect}`;
  let db: IsolatedDb;
  before(async () => {
    db = await createIsolatedDb(dialect);
  });
  after(async () => {
    await db.cleanup();
  });

  it(`shows the Welcome screen with no connections ${covers("database-explorer › No connections")}`, async () => {
    await Welcome.newConnection().waitForDisplayed({ timeout: 30_000 });
    await expect($("aria/Explorer")).toHaveText(expect.stringContaining("No connections yet"));
  });

  it(`tests and saves a ${dialect} connection ${covers("connection-management › Success")}`, async () => {
    await Welcome.newConnection().click();
    if (dialect === "sqlite") {
      await ConnectionDialog.fillSqlite({ name, path: db.name });
    } else {
      const s = SERVICES[dialect as ServerDialect];
      await ConnectionDialog.fillNetwork({
        name,
        host: s.host,
        port: s.port,
        user: s.user,
        password: s.password,
        database: db.name,
      });
    }
    await ConnectionDialog.testButton().click();
    await $('[role="status"]*=Connected').waitForDisplayed({ timeout: 20_000 });
    await ConnectionDialog.saveButton().click();
  });

  it(`lists the connection and its schema objects in the explorer ${covers("database-explorer › Expand a disconnected connection")}`, async () => {
    await Explorer.connection(name).waitForDisplayed({ timeout: 20_000 });
    await $('.//footer//*[contains(text(), "Connected")]').waitForDisplayed({ timeout: 20_000 });
    await Explorer.reveal(tablesPath(name, db));
    await Explorer.row("users").waitForDisplayed({ timeout: 20_000 });
    await Explorer.row("orders").waitForDisplayed();
  });
});
