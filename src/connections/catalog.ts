import type { DriverId } from "../components/Badge";

/** Which General-tab form a driver uses. `oracle` and `neo4j` are forms of their own. */
export type SettingsKind = "network" | "oracle" | "file" | "uri" | "keyvalue" | "neo4j";

export interface CatalogDriver {
  id: DriverId;
  name: string;
  badge: string;
  /** CSS colour token, e.g. `var(--drv-postgres)`. */
  color: string;
  kind: SettingsKind;
  port?: number;
  family: "sql" | "nosql";
  /** Scheme used by the URL preview. */
  scheme: string;
}

const d = (
  id: DriverId,
  name: string,
  badge: string,
  kind: SettingsKind,
  family: "sql" | "nosql",
  scheme: string,
  port?: number,
): CatalogDriver => ({ id, name, badge, color: `var(--drv-${id})`, kind, port, family, scheme });

/** Every driver Clew knows about, in dialog order. Availability comes from `drivers_list`. */
export const CATALOG: CatalogDriver[] = [
  d("postgres", "PostgreSQL", "PG", "network", "sql", "postgres", 5432),
  d("mysql", "MySQL", "MY", "network", "sql", "mysql", 3306),
  d("mariadb", "MariaDB", "MA", "network", "sql", "mariadb", 3306),
  d("oracle", "Oracle", "OR", "oracle", "sql", "oracle", 1521),
  d("sqlserver", "SQL Server", "MS", "network", "sql", "sqlserver", 1433),
  d("clickhouse", "ClickHouse", "CH", "network", "sql", "clickhouse", 8123),
  d("sqlite", "SQLite", "SQ", "file", "sql", "sqlite"),
  d("duckdb", "DuckDB", "DK", "file", "sql", "duckdb"),
  d("mongodb", "MongoDB", "MG", "uri", "nosql", "mongodb", 27017),
  d("redis", "Redis", "RD", "keyvalue", "nosql", "redis", 6379),
  d("neo4j", "Neo4j", "N4", "neo4j", "nosql", "neo4j", 7687),
];

export function catalogDriver(id: string): CatalogDriver {
  return CATALOG.find((c) => c.id === id) ?? CATALOG[0];
}
