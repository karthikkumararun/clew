import { invoke } from "../../lib/ipc";
import type { NodePath } from "../../lib/ipc/drivers";

/** Exact `SELECT count(*)` for a table or view, on the metadata pool. */
export const explorerCountRows = (connectionId: string, path: NodePath) =>
  invoke<number>("explorer_count_rows", { connectionId, path });
