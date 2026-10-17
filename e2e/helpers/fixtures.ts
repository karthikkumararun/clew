import { Console } from "../pages/Console";
import { launchApp } from "./app";
import { connectionFactory, seedConnections, seedPassword } from "./connections";
import { SERVICES, createIsolatedDb } from "./db";
import type { IsolatedDb, ServerDialect } from "./db";
import { journeyDialect } from "./dialect";
import type { Dialect } from "../seed/generate";
import type { TestDataDir } from "./dataDir";
import { Explorer } from "../pages/Explorer";
import { browser } from "@wdio/globals";

export interface ShopSession {
  db: IsolatedDb;
  /** Name of the saved connection in the explorer. */
  connection: string;
}

/**
 * Start the app with one saved connection to a fresh copy of the `shop` seed (password in the
 * test secret store), connect, and open its console. Returns once the console editor is up.
 */
export async function openShopConsole(
  data: Pick<TestDataDir, "dir" | "dialogQueue">,
  dialect: Dialect = journeyDialect(),
  environment: "local" | "development" | "staging" | "production" = "local",
): Promise<ShopSession> {
  const db = await createIsolatedDb(dialect);
  const connection = `shop-${dialect}`;
  let conn;
  if (dialect === "sqlite") {
    conn = connectionFactory.sqlite(connection, db.name, environment);
    seedConnections(data.dir, [conn]);
  } else {
    const s = SERVICES[dialect as ServerDialect];
    conn = connectionFactory.network(dialect as ServerDialect, connection, {
      port: s.port,
      database: db.name,
      user: s.user,
      environment,
    });
    seedConnections(data.dir, [conn]);
    seedPassword(data.dir, conn.id, s.password);
  }
  await launchApp(data);
  await Explorer.select(connection);
  await browser.keys("Enter");
  await Console.waitForEditor(30_000);
  return { db, connection };
}
