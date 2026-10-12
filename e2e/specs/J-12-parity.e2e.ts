import { $, browser, expect } from "@wdio/globals";
import { launchApp } from "../helpers/app";
import { connectionFactory, seedConnections, seedPassword } from "../helpers/connections";
import { withDataDir } from "../helpers/dataDir";
import { SERVICES, createIsolatedDb, isUp } from "../helpers/db";
import type { IsolatedDb, ServerDialect } from "../helpers/db";
import { Console } from "../pages/Console";
import { Explorer } from "../pages/Explorer";
import { Grid } from "../pages/Grid";

// J-12 cross-driver parity: the same queries on every available SQL driver give the same grid
// values.
const QUERIES = {
  users: "SELECT id, name, email, plan FROM users ORDER BY id LIMIT 12",
  grouped: "SELECT status, COUNT(*) AS n FROM orders GROUP BY status ORDER BY status",
  notes: "SELECT id, notes FROM orders WHERE id IN (5, 10, 11, 22) ORDER BY id",
};

describe("J-12 driver parity", () => {
  const data = withDataDir();
  const dbs: IsolatedDb[] = [];
  const names: string[] = [];
  const results = new Map<string, Record<string, string[][]>>();

  before(async () => {
    const conns = [];
    for (const d of ["postgres", "mysql", "mariadb"] as ServerDialect[]) {
      if (!(await isUp(d))) continue; // compare whatever is running
      const db = await createIsolatedDb(d);
      dbs.push(db);
      const s = SERVICES[d];
      const c = connectionFactory.network(d, `parity-${d}`, {
        port: s.port,
        database: db.name,
        user: s.user,
      });
      seedPassword(data.dir, c.id, s.password);
      conns.push(c);
    }
    const lite = await createIsolatedDb("sqlite");
    dbs.push(lite);
    conns.push(connectionFactory.sqlite("parity-sqlite", lite.name));
    names.push(...conns.map((c) => c.name));
    seedConnections(data.dir, conns);
    await launchApp(data);
  });
  after(async () => {
    for (const db of dbs) await db.cleanup();
  });

  const grid = async (columns: string[]) => {
    const rows = await Grid.rowCount();
    const out: string[][] = [];
    for (let r = 0; r < rows; r++) out.push(await Promise.all(columns.map((c) => Grid.cell(r, c))));
    return out;
  };
  const columnsOf = (sql: string) =>
    sql
      .replace(/^SELECT /, "")
      .split(" FROM ")[0]
      .split(",")
      .map((c) => c.trim().split(" AS ").pop()!);

  for (const name of ["parity-postgres", "parity-mysql", "parity-mariadb", "parity-sqlite"]) {
    it(`runs the parity queries on ${name}`, async function () {
      if (!names.includes(name)) return this.skip();
      await Explorer.select(name);
      await browser.keys("Enter");
      await $("aria/SQL editor").waitForDisplayed({ timeout: 30_000 });
      const per: Record<string, string[][]> = {};
      for (const [key, sql] of Object.entries(QUERIES)) {
        await Console.setText(sql);
        await Console.run();
        const cols = columnsOf(sql);
        await browser.waitUntil(
          async () =>
            (await Grid.columnNames()).join() === cols.join() && (await Grid.rowCount()) > 0,
          {
            timeout: 30_000,
            timeoutMsg: `${name}: rows for ${key} expected`,
          },
        );
        per[key] = await grid(cols);
      }
      results.set(name, per);
    });
  }

  it(`shows the same values on every driver`, () => {
    const [[, first], ...rest] = [...results.entries()];
    expect(rest.length).toBeGreaterThan(0);
    for (const [name, got] of rest) {
      for (const key of Object.keys(QUERIES)) {
        expect(`${name} ${key}: ${JSON.stringify(got[key])}`).toBe(
          `${name} ${key}: ${JSON.stringify(first[key])}`,
        );
      }
    }
  });
});
