// Generates the `shop` seed for every SQL dialect from one definition, so the databases hold the
// same logical data (spec: e2e-testing › Shared seed dataset). Run: pnpm exec tsx e2e/seed/generate.ts
// The outputs are committed; `seed.test.ts` fails when they drift from this file.
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Dialect = "postgres" | "mysql" | "mariadb" | "sqlite";
export const DIALECTS: Dialect[] = ["postgres", "mysql", "mariadb", "sqlite"];
export const EVENT_ROWS = 100_000;
export const COUNTS = {
  users: 50,
  orders: 200,
  order_items: 500,
  shipments: 120,
  events: EVENT_ROWS,
};

const BASE_MS = Date.UTC(2024, 0, 1);
const NAMES = [
  "Ada Lovelace",
  "Zoë Müller",
  "Søren Kierkegaard",
  "李雷",
  "Grace Hopper",
  "Renée O'Brien",
  "Alan Turing",
  "Ñandú Pérez",
  "Katherine Johnson",
  "Émile Zola",
];

type Cell = string | number | null;

/** A UTC instant `seconds` after 2024-01-01, written for each dialect. */
function ts(d: Dialect, seconds: number): string {
  const iso = new Date(BASE_MS + seconds * 1000).toISOString().slice(0, 19);
  if (d === "sqlite") return `${iso}Z`;
  const plain = iso.replace("T", " ");
  return d === "postgres" ? `${plain}+00` : plain;
}

const cents = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;

export function rows(d: Dialect) {
  const users: Cell[][] = [];
  for (let id = 1; id <= COUNTS.users; id++) {
    const base = NAMES[(id - 1) % NAMES.length];
    users.push([
      id,
      id > NAMES.length ? `${base} #${Math.floor((id - 1) / NAMES.length) + 1}` : base,
      id % 7 === 0 ? null : `user${id}@example.com`,
      ["free", "pro", "team"][id % 3],
      id % 2 === 0 ? `{"theme":"dark","n":${id}}` : `{"theme":"light","tags":["a","b"]}`,
      ts(d, id * 86400),
    ]);
  }
  const orders: Cell[][] = [];
  for (let id = 1; id <= COUNTS.orders; id++) {
    orders.push([
      id,
      ((id * 7) % COUNTS.users) + 1,
      ["pending", "paid", "shipped", "cancelled"][id % 4],
      cents((id * 1337) % 100000),
      id % 5 === 0 ? null : id % 11 === 0 ? "Gift wrap – ünïcode ✓" : `note ${id}`,
      ts(d, id * 3600),
    ]);
  }
  const items: Cell[][] = [];
  for (let id = 1; id <= COUNTS.order_items; id++) {
    items.push([
      id,
      ((id * 3) % COUNTS.orders) + 1,
      `SKU-${id % 40}`,
      (id % 5) + 1,
      `${String(id).padStart(20, "1")}.1234567890`, // 30 significant digits
    ]);
  }
  const shipments: Cell[][] = [];
  for (let id = 1; id <= COUNTS.shipments; id++) {
    shipments.push([id, id, ["UPS", "DHL", "FedEx"][id % 3], ts(d, id * 7200)]);
  }
  return { users, orders, order_items: items, shipments };
}

const lit = (v: Cell) =>
  v === null ? "NULL" : typeof v === "number" ? String(v) : `'${v.replaceAll("'", "''")}'`;

function insert(table: string, cols: string[], data: Cell[][]): string {
  const out: string[] = [];
  for (let i = 0; i < data.length; i += 100) {
    const chunk = data.slice(i, i + 100).map((r) => `(${r.map(lit).join(", ")})`);
    out.push(`INSERT INTO ${table} (${cols.join(", ")}) VALUES\n${chunk.join(",\n")};`);
  }
  return out.join("\n");
}

const KINDS = ["view", "click", "buy", "refund", "login"];

const ddl: Record<Dialect, string> = {
  postgres: `DROP TABLE IF EXISTS events, shipments, order_items, orders, users CASCADE;
CREATE TABLE users (id integer PRIMARY KEY, name text NOT NULL, email text, plan text NOT NULL, prefs jsonb, created_at timestamptz NOT NULL);
CREATE TABLE orders (id integer PRIMARY KEY, user_id integer NOT NULL REFERENCES users(id), status varchar(20) NOT NULL, total numeric(12,2) NOT NULL, notes text, created_at timestamptz NOT NULL);
CREATE TABLE order_items (id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES orders(id), sku varchar(20) NOT NULL, qty integer NOT NULL, price_exact numeric(30,10) NOT NULL);
CREATE TABLE shipments (id integer PRIMARY KEY, order_id integer NOT NULL REFERENCES orders(id), carrier varchar(20) NOT NULL, shipped_at timestamptz NOT NULL);
CREATE TABLE events (id integer PRIMARY KEY, user_id integer NOT NULL, kind varchar(20) NOT NULL, amount_cents integer NOT NULL, occurred_at timestamptz NOT NULL);`,
  mysql: mysqlDdl(),
  mariadb: mysqlDdl(),
  sqlite: `DROP TABLE IF EXISTS events; DROP TABLE IF EXISTS shipments; DROP TABLE IF EXISTS order_items; DROP TABLE IF EXISTS orders; DROP TABLE IF EXISTS users;
CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, plan TEXT NOT NULL, prefs TEXT, created_at TEXT NOT NULL);
CREATE TABLE orders (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL, total NUMERIC NOT NULL, notes TEXT, created_at TEXT NOT NULL);
CREATE TABLE order_items (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), sku TEXT NOT NULL, qty INTEGER NOT NULL, price_exact TEXT NOT NULL);
CREATE TABLE shipments (id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id), carrier TEXT NOT NULL, shipped_at TEXT NOT NULL);
CREATE TABLE events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, amount_cents INTEGER NOT NULL, occurred_at TEXT NOT NULL);`,
};

function mysqlDdl(): string {
  return `SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS events, shipments, order_items, orders, users;
SET FOREIGN_KEY_CHECKS = 1;
CREATE TABLE users (id int PRIMARY KEY, name varchar(100) NOT NULL, email varchar(200), plan varchar(20) NOT NULL, prefs json, created_at datetime(3) NOT NULL) DEFAULT CHARSET utf8mb4;
CREATE TABLE orders (id int PRIMARY KEY, user_id int NOT NULL, status varchar(20) NOT NULL, total decimal(12,2) NOT NULL, notes text, created_at datetime(3) NOT NULL, FOREIGN KEY (user_id) REFERENCES users(id)) DEFAULT CHARSET utf8mb4;
CREATE TABLE order_items (id int PRIMARY KEY, order_id int NOT NULL, sku varchar(20) NOT NULL, qty int NOT NULL, price_exact decimal(30,10) NOT NULL, FOREIGN KEY (order_id) REFERENCES orders(id)) DEFAULT CHARSET utf8mb4;
CREATE TABLE shipments (id int PRIMARY KEY, order_id int NOT NULL, carrier varchar(20) NOT NULL, shipped_at datetime(3) NOT NULL, FOREIGN KEY (order_id) REFERENCES orders(id)) DEFAULT CHARSET utf8mb4;
CREATE TABLE events (id int PRIMARY KEY, user_id int NOT NULL, kind varchar(20) NOT NULL, amount_cents int NOT NULL, occurred_at datetime(3) NOT NULL) DEFAULT CHARSET utf8mb4;`;
}

/** 100,000 deterministic events, generated by the server so the seed file stays small. */
function eventsSql(d: Dialect): string {
  const cols = "(id, user_id, kind, amount_cents, occurred_at)";
  const user = `(g * 7919) % ${COUNTS.users} + 1`;
  const amount = "(g * 37) % 10000";
  if (d === "postgres") {
    const kind = `(ARRAY[${KINDS.map((k) => `'${k}'`).join(",")}])[g % 5 + 1]`;
    return `INSERT INTO events ${cols}
SELECT g, ${user}, ${kind}, ${amount}, timestamptz '2024-01-01 00:00:00+00' + g * interval '1 second'
FROM generate_series(1, ${EVENT_ROWS}) AS g;`;
  }
  if (d === "sqlite") {
    const kind = `CASE g % 5 ${KINDS.map((k, i) => `WHEN ${i} THEN '${k}'`).join(" ")} END`;
    return `WITH RECURSIVE n(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM n WHERE g < ${EVENT_ROWS})
INSERT INTO events ${cols}
SELECT g, ${user}, ${kind}, ${amount}, strftime('%Y-%m-%dT%H:%M:%SZ', ${BASE_MS / 1000} + g, 'unixepoch') FROM n;`;
  }
  const kind = `ELT(g % 5 + 1, ${KINDS.map((k) => `'${k}'`).join(", ")})`;
  const setting =
    d === "mysql"
      ? "SET SESSION cte_max_recursion_depth = 200000;"
      : "SET SESSION max_recursive_iterations = 200000;";
  return `${setting}
INSERT INTO events ${cols}
WITH RECURSIVE n(g) AS (SELECT 1 UNION ALL SELECT g + 1 FROM n WHERE g < ${EVENT_ROWS})
SELECT g, ${user}, ${kind}, ${amount}, TIMESTAMP('2024-01-01 00:00:00') + INTERVAL g SECOND FROM n;`;
}

export function seedSql(d: Dialect): string {
  const r = rows(d);
  return [
    `-- Generated by e2e/seed/generate.ts for ${d}. Do not edit by hand.`,
    ddl[d],
    insert("users", ["id", "name", "email", "plan", "prefs", "created_at"], r.users),
    insert("orders", ["id", "user_id", "status", "total", "notes", "created_at"], r.orders),
    insert("order_items", ["id", "order_id", "sku", "qty", "price_exact"], r.order_items),
    insert("shipments", ["id", "order_id", "carrier", "shipped_at"], r.shipments),
    eventsSql(d),
    "",
  ].join("\n");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = dirname(fileURLToPath(import.meta.url));
  for (const d of DIALECTS) writeFileSync(join(dir, `${d}.sql`), seedSql(d));
  console.log(`wrote ${DIALECTS.length} seed files`);
}
