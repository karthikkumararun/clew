/** Typed bindings for the connection commands (`src-tauri/src/commands/connections.rs`). */
import { listen } from "@tauri-apps/api/event";
import { invoke } from "../lib/ipc";
import type { ConnectedInfo } from "../lib/ipc/generated/ConnectedInfo";
import type { ConnectionsFile } from "../lib/ipc/generated/ConnectionsFile";
import type { ExportOptions } from "../lib/ipc/generated/ExportOptions";
import type { CommitOptions } from "../lib/ipc/generated/CommitOptions";
import type { DataGripInstall } from "../lib/ipc/generated/DataGripInstall";
import type { ExportSummary } from "../lib/ipc/generated/ExportSummary";
import type { FileInfo } from "../lib/ipc/generated/FileInfo";
import type { FolderRename } from "../lib/ipc/generated/FolderRename";
import type { ImportResult } from "../lib/ipc/generated/ImportResult";
import type { ImportSource } from "../lib/ipc/generated/ImportSource";
import type { PasswordSafeInfo } from "../lib/ipc/generated/PasswordSafeInfo";
import type { ScanView } from "../lib/ipc/generated/ScanView";
import type { Selection } from "../lib/ipc/generated/Selection";
import type { Group } from "../lib/ipc/generated/Group";
import type { HostKeyPrompt } from "../lib/ipc/generated/HostKeyPrompt";
import type { ParsedUrl } from "../lib/ipc/generated/ParsedUrl";
import type { PasswordPrompt } from "../lib/ipc/generated/PasswordPrompt";
import type { ScriptsInfo } from "../lib/ipc/generated/ScriptsInfo";
import type { SaveOutcome } from "../lib/ipc/generated/SaveOutcome";
import type { SaveRequest } from "../lib/ipc/generated/SaveRequest";
import type { SecretStatus } from "../lib/ipc/generated/SecretStatus";
import type { ServerInfo } from "../lib/ipc/generated/ServerInfo";

export type { ConnectedInfo };
export type { Connection } from "../lib/ipc/generated/Connection";
export type { ConnectionsFile } from "../lib/ipc/generated/ConnectionsFile";
export type { Environment } from "../lib/ipc/generated/Environment";
export type { Group } from "../lib/ipc/generated/Group";
export type { ParsedUrl } from "../lib/ipc/generated/ParsedUrl";
export type { PasswordPrompt } from "../lib/ipc/generated/PasswordPrompt";
export type { SaveOutcome } from "../lib/ipc/generated/SaveOutcome";
export type { SaveRequest } from "../lib/ipc/generated/SaveRequest";
export type { SecretStatus } from "../lib/ipc/generated/SecretStatus";
export type { ServerInfo } from "../lib/ipc/generated/ServerInfo";

export const connectionsList = () => invoke<ConnectionsFile>("connections_list");
export const connectionsSave = (request: SaveRequest) =>
  invoke<SaveOutcome>("connections_save", { request });
export const connectionsDelete = (connectionId: string) =>
  invoke<string[]>("connections_delete", { connectionId });
export const connectionsDuplicate = (connectionId: string) =>
  invoke<SaveOutcome>("connections_duplicate", { connectionId });
export const groupsSave = (group: Group) => invoke<Group>("groups_save", { group });
export const groupsDelete = (groupId: string) => invoke<void>("groups_delete", { groupId });
export const connectionSecretStatus = (connectionId: string) =>
  invoke<SecretStatus>("connection_secret_status", { connectionId });
export const connectionsParseUrl = (url: string) =>
  invoke<ParsedUrl>("connections_parse_url", { url });
export const connectionsTest = (request: SaveRequest, testId: string) =>
  invoke<ServerInfo>("connections_test", { request, testId });
export const connectionsTestCancel = (testId: string) =>
  invoke<void>("connections_test_cancel", { testId });

/** Answer a `password_prompt`; `null` cancels. */
export const passwordAnswer = (promptId: string, password: string | null) =>
  invoke<boolean>("password_answer", { promptId, password });

export function onPasswordPrompt(handler: (p: PasswordPrompt) => void): Promise<() => void> {
  return listen<PasswordPrompt>("password_prompt", (e) => handler(e.payload));
}

export const connectionsConnect = (connectionId: string) =>
  invoke<ConnectedInfo>("connections_connect", { connectionId });
export const connectionsOpenTransactions = (connectionId: string) =>
  invoke<string[]>("connections_open_transactions", { connectionId });
export const connectionsDisconnect = (
  connectionId: string,
  endTransactions?: "commit" | "rollback",
) => invoke<void>("connections_disconnect", { connectionId, endTransactions });
export const sessionSwitchNamespace = (
  sessionId: string,
  target: { database?: string; schema?: string },
) =>
  invoke<string>("session_switch_namespace", {
    sessionId,
    database: target.database,
    schema: target.schema,
  });

export function onHostKeyPromptEvent(handler: (p: HostKeyPrompt) => void): Promise<() => void> {
  return listen<HostKeyPrompt>("host_key_prompt", (e) => handler(e.payload));
}

export type { ExportOptions } from "../lib/ipc/generated/ExportOptions";
export type { ExportSummary } from "../lib/ipc/generated/ExportSummary";

export const connectionsExportSummary = (connectionIds: string[], options: ExportOptions) =>
  invoke<ExportSummary>("connections_export_summary", { connectionIds, options });
export const connectionsExport = (
  connectionIds: string[],
  options: ExportOptions,
  passphrase: string | null,
  path: string,
) => invoke<ExportSummary>("connections_export", { connectionIds, options, passphrase, path });

export type { CandidateView } from "../lib/ipc/generated/CandidateView";
export type { CommitOptions } from "../lib/ipc/generated/CommitOptions";
export type { DataGripInstall } from "../lib/ipc/generated/DataGripInstall";
export type { FileInfo } from "../lib/ipc/generated/FileInfo";
export type { ImportResult } from "../lib/ipc/generated/ImportResult";
export type { ImportSource } from "../lib/ipc/generated/ImportSource";
export type { PasswordSafeInfo } from "../lib/ipc/generated/PasswordSafeInfo";
export type { ScanView } from "../lib/ipc/generated/ScanView";
export type { Selection } from "../lib/ipc/generated/Selection";

export const importDatagripDiscover = () => invoke<DataGripInstall[]>("import_datagrip_discover");
export const importDatagripPasswordSafe = (dir: string) =>
  invoke<PasswordSafeInfo>("import_datagrip_password_safe", { dir });
export const importClewInspect = (path: string) =>
  invoke<FileInfo>("import_clew_inspect", { path });
export const importScan = (source: ImportSource) => invoke<ScanView>("import_scan", { source });
export const importCommit = (scanId: string, selections: Selection[], options: CommitOptions) =>
  invoke<ImportResult>("import_commit", { scanId, selections, options });

export type { FolderRename } from "../lib/ipc/generated/FolderRename";
export type { ScriptsInfo } from "../lib/ipc/generated/ScriptsInfo";

export const connectionsScriptsInfo = (connectionId: string) =>
  invoke<ScriptsInfo>("connections_scripts_info", { connectionId });
/** Rename; returns an offer to rename the Scripts folder too when it follows the name. */
export const connectionsRename = (connectionId: string, name: string) =>
  invoke<FolderRename | null>("connections_rename", { connectionId, name });
export const connectionsFinishFolderRename = (
  connectionId: string,
  offer: FolderRename,
  renameFolder: boolean,
) => invoke<void>("connections_finish_folder_rename", { connectionId, offer, renameFolder });
