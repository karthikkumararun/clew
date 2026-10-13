import { readFileSync } from "node:fs";

/**
 * The Neo4j service of the `graph` Compose profile (spec: graph-browser; docker-compose.yml).
 * Ports and credentials are fixed and test-only. Community edition has one user database
 * (`neo4j`), so there is no database per test file like SQL has: a journey that changes the graph
 * calls `resetGraph()` first (and leaves the seed behind when it is done).
 *
 * Talks to the HTTP transaction endpoint, so the harness needs no Bolt driver. Numbers come back
 * as JavaScript numbers: select `toString(n.big)` to read an integer beyond 2^53 exactly.
 */
export const NEO4J = {
  host: "127.0.0.1",
  boltPort: 17687,
  httpPort: 17474,
  user: "neo4j",
  password: "clewclew",
  database: "neo4j",
} as const;

/** What the seed (docker/neo4j/seed.cypher) holds. */
export const GRAPH_SEED = {
  labels: { User: 5, Product: 6, Order: 4, Category: 3 },
  relationshipTypes: { BOUGHT: 8, IN_CATEGORY: 6, PLACED: 4, CONTAINS: 7, FOLLOWS: 4 },
  /** `Product.name`, the node the journeys expand. */
  product: "Brass Lamp",
  /** `Order.reference` of order `O-1001`: 2^53 + 1, the first integer a JavaScript number loses. */
  bigInteger: "9007199254740993",
} as const;

export interface GraphDb {
  /** Run one statement and return its rows as objects keyed by column. */
  query(cypher: string, params?: Record<string, unknown>): Promise<Record<string, unknown>[]>;
  /** Delete everything and load the seed again. */
  reset(): Promise<void>;
}

interface TxResponse {
  results: { columns: string[]; data: { row: unknown[] }[] }[];
  errors: { code: string; message: string }[];
}

const auth = `Basic ${Buffer.from(`${NEO4J.user}:${NEO4J.password}`).toString("base64")}`;
const endpoint = `http://${NEO4J.host}:${NEO4J.httpPort}/db/${NEO4J.database}/tx/commit`;

async function post(statements: { statement: string; parameters?: object }[]): Promise<TxResponse> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: auth,
    },
    body: JSON.stringify({ statements }),
  });
  if (!res.ok) throw new Error(`Neo4j HTTP ${res.status}`);
  const body = (await res.json()) as TxResponse;
  if (body.errors.length > 0) {
    throw new Error(`${body.errors[0].code}: ${body.errors[0].message}`);
  }
  return body;
}

/** The statements of the seed file: comment lines dropped, split at the `;` that ends a line. */
export function seedStatements(): string[] {
  const text = readFileSync(new URL("../../docker/neo4j/seed.cypher", import.meta.url), "utf8");
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n")
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function connectGraph(): Promise<GraphDb> {
  const db: GraphDb = {
    async query(cypher, params = {}) {
      const { results } = await post([{ statement: cypher, parameters: params }]);
      const r = results[0];
      return r.data.map((d) => Object.fromEntries(r.columns.map((c, i) => [c, d.row[i]])));
    },
    async reset() {
      await post([{ statement: "MATCH (n) DETACH DELETE n" }]);
      for (const statement of seedStatements()) await post([{ statement }]);
    },
  };
  return db;
}

/** Is the graph service reachable (the `graph` profile is up)? */
export async function isGraphUp(): Promise<boolean> {
  try {
    await (await connectGraph()).query("RETURN 1 AS ok");
    return true;
  } catch {
    return false;
  }
}
