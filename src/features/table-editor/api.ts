import { invoke } from "../../lib/ipc";
import type { NodePath } from "../../lib/ipc/drivers";
import type { TableMeta } from "../../lib/ipc/generated/TableMeta";
import type { TableQuery } from "../../lib/ipc/generated/TableQuery";
import type { TableQueryRequest } from "../../lib/ipc/generated/TableQueryRequest";

export type { TableMeta, TableQuery, TableQueryRequest };
export type { ColumnDetail } from "../../lib/ipc/generated/ColumnDetail";
export type { ForeignKeyDetail } from "../../lib/ipc/generated/ForeignKeyDetail";
export type { IndexDetail } from "../../lib/ipc/generated/IndexDetail";
export type { ReferencedBy } from "../../lib/ipc/generated/ReferencedBy";

/** Columns, indexes, foreign keys and statistics of a table. */
export const tableMeta = (connectionId: string, path: NodePath) =>
  invoke<TableMeta>("table_meta", { connectionId, path });

/** The SELECT and count behind the Data view, for the connection's dialect. */
export const tableQuerySql = (connectionId: string, request: TableQueryRequest) =>
  invoke<TableQuery>("table_query_sql", { connectionId, request });
