import type { Value } from "../../lib/ipc/drivers";
import type { SqlFlavor } from "../grid/sqlLiteral";
import { lookOf } from "../grid/cellStyle";
import { tableQuerySql } from "./api";
import type { ForeignKeyDetail, ReferencedBy } from "./api";
import { andWhere, quickFilterSql, siblingTablePath } from "./paths";
import type { TableRuntime } from "./runtime";

/** `"a" = 1 AND "b" = 'x'` for a set of columns and the row's values. */
export function equalsWhere(flavor: SqlFlavor, columns: string[], values: Value[]): string {
  return columns.reduce(
    (where, c, i) => andWhere(where, quickFilterSql(flavor, c, values[i], "equals")),
    "",
  );
}

export interface ReferenceLink {
  fk: ForeignKeyDetail;
  /** `users #1042 · Ada Lovelace · ada@example.com` */
  label: string;
  where: string;
}

export interface ReferencedLink {
  ref: ReferencedBy;
  rows: number | null;
  where: string;
}

const firstNumber = (v: Value | undefined): number | null => {
  if (!v) return null;
  if (v.kind === "int") return v.value;
  if (v.kind === "bigint" || v.kind === "decimal") return Number(v.value);
  return null;
};

/** The foreign keys of `row` that point somewhere, each with a label from the target row. */
export async function loadReferences(
  runtime: TableRuntime,
  flavor: SqlFlavor,
  fks: ForeignKeyDetail[],
  columnNames: string[],
  row: Value[],
): Promise<ReferenceLink[]> {
  const links: ReferenceLink[] = [];
  for (const fk of fks) {
    const values = fk.columns.map((c) => row[columnNames.indexOf(c)]);
    if (values.some((v) => !v || v.kind === "null")) continue;
    const where = equalsWhere(flavor, fk.refColumns, values);
    const id = values.map((v) => lookOf(v).text).join(", ");
    let label = `${fk.refTable} #${id}`;
    try {
      const target = siblingTablePath(runtime.path, fk.refSchema ?? null, fk.refTable);
      const q = await tableQuerySql(runtime.connectionId, {
        path: target,
        whereClause: where,
        orderBy: null,
        offset: 0,
        limit: 1,
        defaultOrder: [],
      });
      const { result } = await runtime.run(await runtime.ensureSession(), q.select, 1);
      const found = result?.rows[0];
      if (found && result) {
        const names = result.columns
          .map((c, i) => ({ c, v: found[i] }))
          .filter(
            ({ c, v }) => c.kind === "text" && v.kind === "text" && !fk.refColumns.includes(c.name),
          )
          .slice(0, 2)
          .map(({ v }) => lookOf(v).text);
        if (names.length) label += ` · ${names.join(" · ")}`;
      } else {
        label += " · not found";
      }
    } catch {
      // the label is a nicety; the link still works
    }
    links.push({ fk, label, where });
  }
  return links;
}

/** The tables pointing at this row, with how many of their rows do. */
export async function loadReferencedBy(
  runtime: TableRuntime,
  flavor: SqlFlavor,
  refs: ReferencedBy[],
  columnNames: string[],
  row: Value[],
): Promise<ReferencedLink[]> {
  const links: ReferencedLink[] = [];
  for (const ref of refs) {
    const values = ref.refColumns.map((c) => row[columnNames.indexOf(c)]);
    if (values.some((v) => !v || v.kind === "null")) continue;
    const where = equalsWhere(flavor, ref.columns, values);
    let rows: number | null;
    try {
      const target = siblingTablePath(runtime.path, ref.schema ?? null, ref.table);
      const q = await tableQuerySql(runtime.connectionId, {
        path: target,
        whereClause: where,
        orderBy: null,
        offset: 0,
        limit: 1,
        defaultOrder: [],
      });
      const { result } = await runtime.run(await runtime.ensureSession(), q.count, 1);
      rows = firstNumber(result?.rows[0]?.[0]);
    } catch {
      rows = null;
    }
    links.push({ ref, rows, where });
  }
  return links;
}
