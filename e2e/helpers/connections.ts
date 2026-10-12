import { mkdirSync, writeFileSync } from "node:fs";
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
