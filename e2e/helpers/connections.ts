import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "../../src/lib/ipc/generated/Connection";
import type { ConnectionsFile } from "../../src/lib/ipc/generated/ConnectionsFile";

type Env = Connection["environment"];

const base = (id: string, name: string, driver: string, environment: Env) => ({
  id,
  name,
  driver,
  environment,
  tls: { mode: "disable" as const },
  advanced: {
    connectTimeoutSec: 10,
    queryTimeoutSec: 0,
    keepAliveSec: 0,
    onConnect: [],
    properties: {},
  },
  safeguards:
    environment === "production"
      ? { readOnlyByDefault: true, confirmWrites: true, manualCommit: true }
      : { readOnlyByDefault: false, confirmWrites: false, manualCommit: false },
});

/** Builders for entries of `connections.json`. Passwords are never in this file. */
export const connectionFactory = {
  sqlite(name: string, path: string, environment: Env = "local"): Connection {
    return {
      ...base(`e2e-${name}`, name, "sqlite", environment),
      settings: { kind: "file", path, createIfMissing: true },
    };
  },
  /** The Neo4j service of the `graph` Compose profile (see helpers/neo4j.ts). */
  neo4j(name: string, o: { port: number; user: string; environment?: Env }): Connection {
    return {
      ...base(`e2e-${name}`, name, "neo4j", o.environment ?? "local"),
      settings: {
        kind: "neo4j",
        protocol: "bolt",
        host: "127.0.0.1",
        port: o.port,
        user: o.user,
        database: "neo4j",
        passwordMode: "keychain",
      },
    };
  },
  network(
    driver: "postgres" | "mysql" | "mariadb",
    name: string,
    o: { host?: string; port: number; database: string; user: string; environment?: Env },
  ): Connection {
    return {
      ...base(`e2e-${name}`, name, driver, o.environment ?? "local"),
      settings: {
        kind: "network",
        host: o.host ?? "127.0.0.1",
        port: o.port,
        database: o.database,
        user: o.user,
        passwordMode: "keychain",
      },
    };
  },
};

/** Write `connections.json` into a data directory before the app starts. */
export function seedConnections(dataDir: string, connections: Connection[]): void {
  const file: ConnectionsFile = { version: 1, groups: [], connections };
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "connections.json"), JSON.stringify(file, null, 2));
}

/** Put a password into the test-mode secret store (`e2e-secrets.json`) before the app starts. */
export function seedPassword(dataDir: string, connectionId: string, password: string): void {
  mkdirSync(dataDir, { recursive: true });
  const file = join(dataDir, "e2e-secrets.json");
  const current = existsSync(file)
    ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>)
    : {};
  current[`${connectionId}:password`] = password;
  writeFileSync(file, JSON.stringify(current));
}
