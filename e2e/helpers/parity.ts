import { createHash } from "node:crypto";
import type { Dialect } from "../seed/generate";
import { COUNTS, DIALECTS } from "../seed/generate";
import type { Db, ServerDialect } from "./db";
import { connectServer, createIsolatedDb, isUp, openSqlite } from "./db";

const SAMPLE_ROWS = 1000;

type Fmt = "text" | "money" | "ts" | "json";
interface Col {
  name: string;
  fmt?: Fmt;
}
const TABLES: Record<string, Col[]> = {
  users: [
    { name: "id" },
    { name: "name" },
    { name: "email" },
    { name: "plan" },
    { name: "prefs", fmt: "json" },
    { name: "created_at", fmt: "ts" },
  ],
  orders: [
    { name: "id" },
    { name: "user_id" },
    { name: "status" },
    { name: "total", fmt: "money" },
    { name: "notes" },
    { name: "created_at", fmt: "ts" },
  ],
  order_items: [
    { name: "id" },
    { name: "order_id" },
    { name: "sku" },
    { name: "qty" },
    { name: "price_exact" },
  ],
  shipments: [
    { name: "id" },
    { name: "order_id" },
    { name: "carrier" },
    { name: "shipped_at", fmt: "ts" },
  ],
  events: [
    { name: "id" },
    { name: "user_id" },
    { name: "kind" },
    { name: "amount_cents" },
    { name: "occurred_at", fmt: "ts" },
  ],
};

/** The same instant as `YYYY-MM-DDTHH:MM:SS` (UTC) whatever the column type. */
function tsExpr(d: Dialect, col: string): string {
  if (d === "postgres") return `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS')`;
  if (d === "sqlite") return `substr(${col}, 1, 19)`;
  return `DATE_FORMAT(${col}, '%Y-%m-%dT%H:%i:%s')`;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, x]) => [k, canonical(x)]),
    );
  }
  return v;
}

function norm(v: unknown, fmt: Fmt = "text"): string {
  if (v === null || v === undefined) return "∅";
  if (fmt === "money") return Number(v).toFixed(2);
  if (fmt === "json") return JSON.stringify(canonical(typeof v === "string" ? JSON.parse(v) : v));
  return String(v);
}

export interface TableDigest {
  count: number;
  /** SHA-256 over the first rows (by id) of the sampled columns, in a normalised text form. */
  checksum: string;
  /** Sums over every row (events only), a cheap check on the generated data. */
  sums?: string;
}

export async function digest(db: Db): Promise<Record<string, TableDigest>> {
  const out: Record<string, TableDigest> = {};
  for (const [table, cols] of Object.entries(TABLES)) {
    const select = cols.map((c) =>
      c.fmt === "ts" ? `${tsExpr(db.dialect, c.name)} AS ${c.name}` : c.name,
    );
    const rows = await db.query(
      `SELECT ${select.join(", ")} FROM ${table} ORDER BY id LIMIT ${SAMPLE_ROWS}`,
    );
    const hash = createHash("sha256");
    for (const r of rows)
      hash.update(
        cols.map((c) => norm(r[c.name], c.fmt === "ts" ? "text" : c.fmt)).join("\u001f") + "\n",
      );
    const [c] = await db.query(`SELECT COUNT(*) AS n FROM ${table}`);
    const entry: TableDigest = { count: Number(c.n), checksum: hash.digest("hex") };
    if (table === "events") {
      const [s] = await db.query(`SELECT SUM(amount_cents) AS a, SUM(user_id) AS u FROM events`);
      entry.sums = `${s.a}/${s.u}`;
    }
    out[table] = entry;
  }
  return out;
}

export interface ParityReport {
  compared: Dialect[];
  skipped: Dialect[];
  differences: string[];
}

/** Compare row counts and sampled checksums across every database that is up (plus SQLite). */
export async function checkParity(): Promise<ParityReport> {
  const digests = new Map<Dialect, Record<string, TableDigest>>();
  const skipped: Dialect[] = [];
  for (const d of DIALECTS) {
    if (d === "sqlite") {
      const iso = await createIsolatedDb("sqlite");
      const db = openSqlite(iso.name);
      digests.set(d, await digest(db));
      await db.close();
      await iso.cleanup();
    } else if (await isUp(d as ServerDialect)) {
      const iso = await createIsolatedDb(d);
      const db = await connectServer(d as ServerDialect, iso.name);
      digests.set(d, await digest(db));
      await db.close();
      await iso.cleanup();
    } else {
      skipped.push(d);
    }
  }
  const differences: string[] = [];
  for (const [d, dg] of digests) {
    for (const [table, want] of Object.entries(COUNTS)) {
      if (dg[table].count !== want)
        differences.push(`${d}.${table}: ${dg[table].count} rows, expected ${want}`);
    }
  }
  const [first, ...rest] = [...digests.entries()];
  if (first) {
    for (const [d, dg] of rest) {
      for (const table of Object.keys(TABLES)) {
        const a = first[1][table];
        const b = dg[table];
        if (a.checksum !== b.checksum)
          differences.push(`${d}.${table}: sampled checksum differs from ${first[0]}`);
        if (a.sums !== b.sums)
          differences.push(`${d}.${table}: sums ${b.sums} differ from ${first[0]} ${a.sums}`);
      }
    }
  }
  return { compared: [...digests.keys()], skipped, differences };
}
