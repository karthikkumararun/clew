import { invoke } from "../../lib/ipc";
import type { NodePath } from "../../lib/ipc/drivers";
import type { ApplyOutcome } from "../../lib/ipc/generated/ApplyOutcome";
import type { ChangeRequest } from "../../lib/ipc/generated/ChangeRequest";
import type { PreviewStatement } from "../../lib/ipc/generated/PreviewStatement";
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

export type { ApplyOutcome } from "../../lib/ipc/generated/ApplyOutcome";
export type { ChangeRequest } from "../../lib/ipc/generated/ChangeRequest";
export type { PreviewStatement } from "../../lib/ipc/generated/PreviewStatement";
export type { ChangeTarget } from "../../lib/ipc/generated/ChangeTarget";
export type { NewValue } from "../../lib/ipc/generated/NewValue";

/** The statements staged edits would run, with the values written out. */
export const changesPreview = (connectionId: string, request: ChangeRequest) =>
  invoke<PreviewStatement[]>("changes_preview", { connectionId, request });

/** Run staged edits in one transaction on the tab's session. */
export const changesApply = (connectionId: string, sessionId: string, request: ChangeRequest) =>
  invoke<ApplyOutcome>("changes_apply", { connectionId, sessionId, request });
