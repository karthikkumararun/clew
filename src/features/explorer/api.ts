import { invoke } from "../../lib/ipc";
import type { NodePath } from "../../lib/ipc/drivers";
import type { ScriptFile } from "../../lib/ipc/generated/ScriptFile";

export type { ScriptFile };

/** Exact `SELECT count(*)` for a table or view, on the metadata pool. */
export const explorerCountRows = (connectionId: string, path: NodePath) =>
  invoke<number>("explorer_count_rows", { connectionId, path });

/** The SQL files in a connection's Scripts folder. */
export const scriptsList = (connectionId: string) =>
  invoke<ScriptFile[]>("connections_scripts_list", { connectionId });
/** Create an empty script; resolves with its absolute path. */
export const scriptsNew = (connectionId: string, name: string) =>
  invoke<string>("connections_scripts_new", { connectionId, name });
/** Show the Scripts folder, or one file in it, in Finder / Explorer. */
export const scriptsReveal = (connectionId: string, relPath?: string) =>
  invoke<void>("connections_scripts_reveal", { connectionId, relPath });
