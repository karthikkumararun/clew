import { invoke } from "../../lib/ipc";
import type { ColumnMeta, NodePath, Value } from "../../lib/ipc/drivers";
import type { EditResolution } from "../../lib/ipc/generated/EditResolution";
import type { TableRef } from "../../lib/ipc/generated/TableRef";

export type { Candidate } from "../../lib/ipc/generated/Candidate";
export type { ColumnEdit } from "../../lib/ipc/generated/ColumnEdit";
export type { EditResolution } from "../../lib/ipc/generated/EditResolution";
export type { ReadOnlyReason } from "../../lib/ipc/generated/ReadOnlyReason";
export type { TableRef } from "../../lib/ipc/generated/TableRef";

/** Which table can this result be edited through (spec: result-editing › Editable query results)? */
export const resultsResolveEdit = (
  connectionId: string,
  sessionId: string,
  statement: string,
  columns: ColumnMeta[],
  chosen?: TableRef | null,
) =>
  invoke<EditResolution>("results_resolve_edit", {
    connectionId,
    sessionId,
    statement,
    columns,
    chosen: chosen ?? null,
  });

/** The rows of `target` read back by key, in the order of `keys` (an empty row = gone). */
export const changesRefetch = (
  connectionId: string,
  sessionId: string,
  target: TableRef,
  columns: string[],
  keyColumns: string[],
  keys: Value[][],
) =>
  invoke<Value[][]>("changes_refetch", {
    connectionId,
    sessionId,
    target,
    columns,
    keyColumns,
    keys,
  });

/** The path the change engine addresses a table by (schema as `database` for MySQL-style servers). */
export function targetPath(driver: string, target: TableRef): NodePath {
  const path: NodePath = [];
  if (target.schema) {
    const asDatabase = ["mysql", "mariadb", "sqlite", "clickhouse"].includes(driver);
    path.push({ kind: asDatabase ? "database" : "schema", name: target.schema });
  }
  path.push({ kind: "table", name: target.table });
  return path;
}
