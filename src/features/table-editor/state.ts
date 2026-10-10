import type { NodePath } from "../../lib/ipc/drivers";
import { nodeId } from "../explorer/tree";

export const TABLE_KIND = "table";

export type TableView = "data" | "structure" | "indexes" | "relations" | "ddl";

export const PAGE_SIZES = [100, 500, 1000] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

/** What a table-editor tab keeps. `connectionId` and `path` let the explorer find its node. */
export interface TableTabState {
  connectionId: string;
  path: NodePath;
  view: TableView;
  /** Raw WHERE / ORDER BY fragments, as applied. */
  where: string;
  orderBy: string;
  pageSize: PageSize;
  /** Zero-based page. */
  page: number;
  /** Record panel open. */
  record: boolean;
  /** The tab's open session; transient. */
  sessionId?: string;
  /** Put the cursor in WHERE after `"column" = `; transient (Filter table by this column). */
  focusColumn?: string;
}

export type TableTab = import("../../shell/registry/tabKinds").Tab<TableTabState>;

export const tableKey = (connectionId: string, path: NodePath) =>
  `table:${nodeId(connectionId, path)}`;

export const tableName = (path: NodePath) => path[path.length - 1]?.name ?? "";

export function serializeTable(s: TableTabState): TableTabState {
  const { sessionId: _session, focusColumn: _focus, ...persisted } = s;
  void _session;
  void _focus;
  return persisted;
}

export function deserializeTable(raw: unknown): TableTabState {
  const r = (raw ?? {}) as Partial<TableTabState>;
  if (typeof r.connectionId !== "string" || !Array.isArray(r.path) || r.path.length === 0) {
    throw new Error("a table editor needs a connection and a table");
  }
  const views: TableView[] = ["data", "structure", "indexes", "relations", "ddl"];
  return {
    connectionId: r.connectionId,
    path: r.path,
    view: views.includes(r.view as TableView) ? (r.view as TableView) : "data",
    where: typeof r.where === "string" ? r.where : "",
    orderBy: typeof r.orderBy === "string" ? r.orderBy : "",
    pageSize: (PAGE_SIZES as readonly number[]).includes(r.pageSize as number)
      ? (r.pageSize as PageSize)
      : 500,
    page: typeof r.page === "number" && r.page >= 0 ? Math.floor(r.page) : 0,
    record: r.record === true,
  };
}

/** The columns that identify a row: the primary key, else the first unique index without NULLs. */
export function rowKeyColumns(meta: {
  columns: { name: string; nullable: boolean; primaryKey: boolean }[];
  indexes: { columns: string[]; unique: boolean; primary: boolean }[];
}): string[] | null {
  const pk = meta.columns.filter((c) => c.primaryKey).map((c) => c.name);
  if (pk.length > 0) return pk;
  const nullable = new Map(meta.columns.map((c) => [c.name, c.nullable]));
  const unique = meta.indexes.find(
    (i) =>
      i.unique &&
      i.columns.length > 0 &&
      i.columns.every((c) => nullable.has(c) && nullable.get(c) === false),
  );
  return unique ? unique.columns : null;
}
