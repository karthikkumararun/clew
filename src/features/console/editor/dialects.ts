import {
  MSSQL,
  MariaSQL,
  MySQL,
  PLSQL,
  PostgreSQL,
  SQLite,
  StandardSQL,
} from "@codemirror/lang-sql";
import type { SQLDialect } from "@codemirror/lang-sql";
import type { SplitDialect } from "./statements";

/** Highlighting / keyword dialect of a driver. */
export function editorDialect(driver: string): SQLDialect {
  switch (driver) {
    case "postgres":
    case "duckdb":
      return PostgreSQL;
    case "mysql":
      return MySQL;
    case "mariadb":
      return MariaSQL;
    case "sqlserver":
      return MSSQL;
    case "sqlite":
      return SQLite;
    case "oracle":
      return PLSQL;
    default:
      return StandardSQL;
  }
}

/** Statement-splitting rules of a driver (the same names the Rust splitter uses). */
export function splitDialect(driver: string): SplitDialect {
  switch (driver) {
    case "postgres":
    case "duckdb": // dollar-quoted strings work the same
      return "postgresql";
    case "mysql":
    case "mariadb":
    case "sqlite":
      return driver;
    default:
      return null;
  }
}

/** `sql-formatter` language of a driver. */
export function formatterLanguage(driver: string) {
  switch (driver) {
    case "postgres":
    case "duckdb":
      return "postgresql" as const;
    case "mysql":
      return "mysql" as const;
    case "mariadb":
      return "mariadb" as const;
    case "sqlserver":
      return "transactsql" as const;
    case "sqlite":
      return "sqlite" as const;
    case "oracle":
      return "plsql" as const;
    default:
      return "sql" as const;
  }
}

/** ClickHouse has no transactions: consoles there are always auto-commit. */
export const supportsTransactions = (driver: string) => driver !== "clickhouse";

/** Human name used in the status bar: "SQL · PostgreSQL dialect". */
export function dialectLabel(driver: string): string {
  const names: Record<string, string> = {
    postgres: "PostgreSQL",
    duckdb: "DuckDB",
    mysql: "MySQL",
    mariadb: "MariaDB",
    sqlserver: "SQL Server",
    sqlite: "SQLite",
    oracle: "Oracle",
    clickhouse: "ClickHouse",
  };
  return `SQL · ${names[driver] ?? "Standard"} dialect`;
}
