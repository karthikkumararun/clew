import type { NodePath } from "../../lib/ipc/drivers";
import { sqlLiteral } from "../grid/sqlLiteral";
import type { SqlFlavor } from "../grid/sqlLiteral";
import { quoteIdent } from "../grid/sqlLiteral";
import type { Value } from "../../lib/ipc/drivers";

/** Path of a table that sits next to the current one (a foreign key's target or source). */
export function siblingTablePath(
  current: NodePath,
  schema: string | null | undefined,
  table: string,
): NodePath {
  const database = current.find((s) => s.kind === "database");
  const hasSchema = current.some((s) => s.kind === "schema");
  const segs: NodePath = [];
  if (database) {
    // MySQL-style servers report the referenced *database* where PostgreSQL reports a schema.
    const db = !hasSchema && schema ? schema : database.name;
    segs.push({ kind: "database", name: db });
  }
  if (hasSchema) {
    segs.push({
      kind: "schema",
      name: schema ?? current.find((s) => s.kind === "schema")?.name ?? "",
    });
  }
  segs.push({ kind: "group", name: "tables" }, { kind: "table", name: table });
  return segs;
}

export type QuickFilter = "equals" | "notEquals" | "isNull" | "notNull" | "contains";

/** The WHERE fragment a cell's right-click filter produces. */
export function quickFilterSql(
  flavor: SqlFlavor,
  column: string,
  value: Value,
  op: QuickFilter,
): string {
  const col = quoteIdent(flavor, column);
  switch (op) {
    case "isNull":
      return `${col} IS NULL`;
    case "notNull":
      return `${col} IS NOT NULL`;
    case "equals":
      return value.kind === "null" ? `${col} IS NULL` : `${col} = ${sqlLiteral(flavor, value)}`;
    case "notEquals":
      return value.kind === "null"
        ? `${col} IS NOT NULL`
        : `${col} <> ${sqlLiteral(flavor, value)}`;
    case "contains": {
      const text = value.kind === "text" ? value.value : "";
      const escaped = text.replace(/[\\%_]/g, (c) => `\\${c}`);
      return `${col} LIKE ${sqlLiteral(flavor, { kind: "text", value: `%${escaped}%` })} ESCAPE '\\'`;
    }
  }
}

/** Add a fragment to the existing WHERE text with AND, keeping an OR in it grouped. */
export function andWhere(existing: string, fragment: string): string {
  const cur = existing.trim().replace(/;+$/, "").trim();
  if (!cur) return fragment;
  return `${/\bOR\b/i.test(cur) ? `(${cur})` : cur} AND ${fragment}`;
}

/** `"col" ASC` / `"col" DESC` for a sort the header cycle chose, or empty for none. */
export function orderFor(flavor: SqlFlavor, column: string, dir: "asc" | "desc" | null): string {
  return dir ? `${quoteIdent(flavor, column)} ${dir.toUpperCase()}` : "";
}

/** The header arrow for an ORDER BY that is exactly one column and a direction. */
export function sortOf(flavor: SqlFlavor, orderBy: string, columns: string[]) {
  const text = orderBy.trim().replace(/\s+/g, " ").toLowerCase();
  if (!text) return null;
  for (let i = 0; i < columns.length; i++) {
    for (const dir of ["asc", "desc"] as const) {
      const forms = [orderFor(flavor, columns[i], dir), `${columns[i]} ${dir}`];
      if (forms.some((f) => f.toLowerCase() === text)) return { column: i, dir };
    }
    const bare = [quoteIdent(flavor, columns[i]), columns[i]];
    if (bare.some((f) => f.toLowerCase() === text)) return { column: i, dir: "asc" as const };
  }
  return null;
}
