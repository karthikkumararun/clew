import type { NodeKind, NodePath } from "../../lib/ipc/drivers";

/** Quote an identifier the way the driver's dialect expects. */
export function quoteIdent(driver: string, name: string): string {
  switch (driver) {
    case "mysql":
    case "mariadb":
    case "clickhouse":
      return `\`${name.replace(/`/g, "``")}\``;
    case "sqlserver":
      return `[${name.replace(/]/g, "]]")}]`;
    default:
      return `"${name.replace(/"/g, '""')}"`;
  }
}

const MYSQL_FAMILY = new Set(["mysql", "mariadb", "clickhouse"]);

function find(path: NodePath, kind: NodeKind): string | undefined {
  for (let i = path.length - 1; i >= 0; i--) if (path[i].kind === kind) return path[i].name;
  return undefined;
}

/** `schema.table` (or `database.table` on MySQL-like servers), quoted. */
export function qualifiedName(driver: string, path: NodePath): string {
  const last = path[path.length - 1];
  if (!last) return "";
  const parent =
    find(path.slice(0, -1), "schema") ??
    (MYSQL_FAMILY.has(driver) ? find(path.slice(0, -1), "database") : undefined);
  const q = (n: string) => quoteIdent(driver, n);
  return parent ? `${q(parent)}.${q(last.name)}` : q(last.name);
}

/** The database and schema a path sits in, for "New console here". */
export function namespaceOf(path: NodePath): { database?: string; schema?: string } {
  return { database: find(path, "database"), schema: find(path, "schema") };
}

export function isTableLike(kind: string): boolean {
  return kind === "table" || kind === "view" || kind === "materialized_view";
}

/** `12.4k` style short counts, the same format the drivers use for estimates. */
export function formatCount(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}
