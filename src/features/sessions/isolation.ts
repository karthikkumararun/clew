import type { Connection } from "../../connections/api";

/**
 * Levels offered before a session exists (and so before the backend can say which it supports).
 * Once a session is open, `SessionMeta.supportedIsolation` is the truth.
 */
const LEVELS_BEFORE_OPEN: Record<string, string[]> = {
  postgres: ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"],
  mysql: ["READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"],
  mariadb: ["READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"],
  sqlserver: ["READ UNCOMMITTED", "READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE", "SNAPSHOT"],
  oracle: ["READ COMMITTED", "SERIALIZABLE"],
};

export const levelsBeforeOpen = (driver: string): string[] => LEVELS_BEFORE_OPEN[driver] ?? [];

/** The connection's default level (Advanced settings); empty when the server's default is used. */
export const defaultIsolationOf = (c: Connection | undefined): string =>
  (c?.advanced as { isolation?: string | null } | undefined)?.isolation ?? "";
