import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../../lib/ipc";
import type { ColumnMeta, Value } from "../../lib/ipc/drivers";
import type { ExportEvent } from "../../lib/ipc/generated/ExportEvent";
import type { ExportDateFormat } from "../../lib/ipc/generated/ExportDateFormat";
import type { FileExportOptions } from "../../lib/ipc/generated/FileExportOptions";
import type { FileExportSummary } from "../../lib/ipc/generated/FileExportSummary";
import type { FileFormat } from "../../lib/ipc/generated/FileFormat";
import type { SqlFlavor } from "../../lib/ipc/generated/SqlFlavor";

export type {
  ExportDateFormat,
  ExportEvent,
  FileExportOptions,
  FileExportSummary,
  FileFormat,
  SqlFlavor,
};

/**
 * Re-run `sql` and stream every row to a file the user picks. Resolves with `null` when the
 * save dialog was cancelled. Cancel through `exportCancel(exportId)`.
 */
export function exportQuery(
  request: {
    exportId: string;
    connectionId: string;
    sql: string;
    format: FileFormat;
    options: FileExportOptions;
    defaultName: string;
  },
  onEvent: (e: ExportEvent) => void,
): Promise<FileExportSummary | null> {
  const channel = new Channel<ExportEvent>();
  channel.onmessage = onEvent;
  return invoke<FileExportSummary | null>("export_query", { request, onEvent: channel });
}

export const exportCancel = (exportId: string) => invoke<void>("export_cancel", { exportId });

/** Write rows the grid already holds. */
export const exportRows = (request: {
  columns: ColumnMeta[];
  rows: Value[][];
  format: FileFormat;
  options: FileExportOptions;
  defaultName: string;
}) => invoke<FileExportSummary | null>("export_rows", { request });
