import { connectServer, openSqlite } from "./db";
import type { Db, IsolatedDb, ServerDialect } from "./db";
import type { Dialect } from "../seed/generate";

/**
 * The database a journey runs against. Default PostgreSQL; the container-free smoke suite sets
 * `CLEW_E2E_DIALECT=sqlite` (scripts/qa-e2e.ts) so it needs no Docker (spec: e2e-testing › Native
 * platform smoke checks).
 */
export function journeyDialect(): Dialect {
  const d = process.env.CLEW_E2E_DIALECT ?? "postgres";
  if (!["postgres", "mysql", "mariadb", "sqlite"].includes(d)) {
    throw new Error(`CLEW_E2E_DIALECT: unknown dialect "${d}"`);
  }
  return d as Dialect;
}

/** A query that runs for about a minute unless cancelled. */
export const LONG_QUERY: Record<Dialect, string> = {
  postgres: "SELECT pg_sleep(60)",
  mysql: "SELECT SLEEP(60)",
  mariadb: "SELECT SLEEP(60)",
  sqlite: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c",
};

/** A second client on the same database, as another user would have. */
export function openSecond(db: IsolatedDb): Promise<Db> {
  return db.dialect === "sqlite"
    ? Promise.resolve(openSqlite(db.name))
    : connectServer(db.dialect as ServerDialect, db.name);
}

/** Explorer rows to expand to reach the tables of a shop database. */
export function tablesPath(connection: string, db: IsolatedDb): string[] {
  if (db.dialect === "sqlite") return [connection, "main", "tables"];
  if (db.dialect === "postgres") return [connection, db.name, "public", "tables"];
  return [connection, db.name, "tables"];
}
