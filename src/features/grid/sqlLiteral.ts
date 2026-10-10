import type { Value } from "../../lib/ipc/drivers";
import { valueText } from "../console/valueFormat";

/** SQL dialects that differ in how literals and identifiers are written. */
export type SqlFlavor = "postgres" | "mysql" | "sqlite" | "sqlserver" | "oracle" | "standard";

export function flavorOf(driver: string): SqlFlavor {
  switch (driver) {
    case "postgres":
    case "duckdb":
      return "postgres";
    case "mysql":
    case "mariadb":
    case "clickhouse":
      return "mysql";
    case "sqlite":
      return "sqlite";
    case "sqlserver":
      return "sqlserver";
    case "oracle":
      return "oracle";
    default:
      return "standard";
  }
}

export function quoteIdent(flavor: SqlFlavor, name: string): string {
  switch (flavor) {
    case "mysql":
      return `\`${name.replace(/`/g, "``")}\``;
    case "sqlserver":
      return `[${name.replace(/]/g, "]]")}]`;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

function quoteText(flavor: SqlFlavor, s: string): string {
  // MySQL treats a backslash in a string as an escape character; the others don't.
  const escaped = flavor === "mysql" ? s.replace(/\\/g, "\\\\") : s;
  return `'${escaped.replace(/'/g, "''")}'`;
}

/** A value written as a SQL literal for the dialect. */
export function sqlLiteral(flavor: SqlFlavor, v: Value): string {
  switch (v.kind) {
    case "null":
      return "NULL";
    case "bool":
      return flavor === "sqlite" || flavor === "sqlserver" || flavor === "oracle"
        ? v.value
          ? "1"
          : "0"
        : v.value
          ? "TRUE"
          : "FALSE";
    case "int":
    case "float":
      return Number.isFinite(v.value) ? String(v.value) : "NULL";
    case "bigint":
    case "decimal":
      return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(v.value) ? v.value : quoteText(flavor, v.value);
    case "bytes":
      if (flavor === "postgres") return `'\\x${v.value}'`;
      if (flavor === "sqlserver") return `0x${v.value}`;
      return `X'${v.value}'`;
    case "json":
      return quoteText(flavor, JSON.stringify(v.value));
    case "array": {
      const inner = v.value.map((x) => valueText(x) ?? "NULL").join(",");
      return quoteText(flavor, `{${inner}}`);
    }
    default:
      return quoteText(flavor, valueText(v) ?? "");
  }
}
