import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Client as PgClient } from "pg";
import { createConnection } from "mysql2/promise";
import type { Connection as MysqlConnection } from "mysql2/promise";
import type { Dialect } from "../seed/generate";

/** Fixed host ports from docker-compose.yml; credentials are test-only. */
export const SERVICES = {
  postgres: { host: "127.0.0.1", port: 54316, user: "clew", password: "clew", admin: "clew" },
  mysql: { host: "127.0.0.1", port: 33068, user: "clew", password: "clew", admin: "root" },
  mariadb: { host: "127.0.0.1", port: 33071, user: "clew", password: "clew", admin: "root" },
} as const;

export type ServerDialect = Exclude<Dialect, "sqlite">;

/** A plain database client for tests: run SQL, read rows. */
export interface Db {
  readonly dialect: Dialect;
  query(sql: string): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const seedFile = (d: Dialect) => readFileSync(new URL(`../seed/${d}.sql`, import.meta.url), "utf8");

/** Open a server database as the admin account (it may create and drop databases). */
export async function connectServer(
  dialect: ServerDialect,
  database?: string,
  admin = true,
): Promise<Db> {
  const s = SERVICES[dialect];
  const user = admin ? s.admin : s.user;
  const password = admin && dialect !== "postgres" ? "clew" : s.password;
  if (dialect === "postgres") {
    const c = new PgClient({
      host: s.host,
      port: s.port,
      user,
      password,
      database: database ?? "clew",
    });
    await c.connect();
    return {
      dialect,
      query: async (sql) => (await c.query(sql)).rows as Record<string, unknown>[],
      exec: async (sql) => void (await c.query(sql)),
      close: () => c.end(),
    };
  }
  const c: MysqlConnection = await createConnection({
    host: s.host,
    port: s.port,
    user,
    password,
    database,
    multipleStatements: true,
    charset: "utf8mb4",
    timezone: "Z",
  });
  return {
    dialect,
    query: async (sql) => (await c.query(sql))[0] as Record<string, unknown>[],
    exec: async (sql) => void (await c.query(sql)),
    close: () => c.end(),
  };
}

export function openSqlite(path: string): Db {
  const db = new DatabaseSync(path);
  return {
    dialect: "sqlite",
    query: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
    exec: async (sql) => db.exec(sql),
    close: async () => db.close(),
  };
}

/** Is the database reachable? Used to run parity over whatever is up. */
export async function isUp(dialect: ServerDialect): Promise<boolean> {
  try {
    await (await connectServer(dialect)).close();
    return true;
  } catch {
    return false;
  }
}

/** A database created for one test file, from the shared seed, and removed afterwards. */
export interface IsolatedDb {
  dialect: Dialect;
  /** Database name (server databases) or file path (SQLite). */
  name: string;
  cleanup(): Promise<void>;
}

let counter = 0;
const unique = () => `e2e_${process.pid}_${Date.now().toString(36)}_${counter++}`;

const TEMPLATE_DB = "shop_seed";

/**
 * Per-file isolation (spec: e2e-testing › Shared seed dataset › Fresh state per test file):
 * PostgreSQL clones a seeded template database, MySQL and MariaDB create a database and run the
 * seed, SQLite copies a seeded template file. `cleanup()` drops or deletes it.
 */
export async function createIsolatedDb(dialect: Dialect): Promise<IsolatedDb> {
  const name = unique();
  if (dialect === "sqlite") {
    const template = join(tmpdir(), "clew-e2e-shop-template.sqlite");
    if (!existsSync(template)) {
      const tmp = `${template}.${process.pid}`;
      const db = openSqlite(tmp);
      await db.exec(seedFile("sqlite"));
      await db.close();
      copyFileSync(tmp, template); // last writer wins; every copy has the same content
      rmSync(tmp, { force: true });
    }
    const dir = join(tmpdir(), name);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "shop.sqlite");
    copyFileSync(template, path);
    return {
      dialect,
      name: path,
      cleanup: async () => {
        // Windows will not delete a file the app under test still has open: retry, then leave the
        // temp folder for the OS rather than fail a journey that already passed.
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "EBUSY") throw e;
        }
      },
    };
  }

  const admin = await connectServer(dialect);
  try {
    if (dialect === "postgres") {
      const have = await admin.query(`SELECT 1 FROM pg_database WHERE datname = '${TEMPLATE_DB}'`);
      if (have.length === 0) {
        await admin.exec(`CREATE DATABASE ${TEMPLATE_DB}`);
        const t = await connectServer("postgres", TEMPLATE_DB);
        await t.exec(seedFile("postgres"));
        await t.close();
      }
      await admin.exec(`CREATE DATABASE ${name} TEMPLATE ${TEMPLATE_DB}`);
    } else {
      await admin.exec(`CREATE DATABASE ${name} CHARACTER SET utf8mb4`);
      const db = await connectServer(dialect, name);
      await db.exec(seedFile(dialect));
      await db.close();
    }
  } finally {
    await admin.close();
  }
  return {
    dialect,
    name,
    cleanup: async () => {
      const a = await connectServer(dialect);
      try {
        // FORCE: the app under test may still hold a connection to it
        await a.exec(
          `DROP DATABASE IF EXISTS ${name}${dialect === "postgres" ? " WITH (FORCE)" : ""}`,
        );
      } finally {
        await a.close();
      }
    },
  };
}
