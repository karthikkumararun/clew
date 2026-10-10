/** Typed bindings for the connection commands (`src-tauri/src/commands/connections.rs`). */
import { listen } from "@tauri-apps/api/event";
import { invoke } from "../lib/ipc";
import type { ConnectedInfo } from "../lib/ipc/generated/ConnectedInfo";
import type { ConnectionsFile } from "../lib/ipc/generated/ConnectionsFile";
import type { Group } from "../lib/ipc/generated/Group";
import type { HostKeyPrompt } from "../lib/ipc/generated/HostKeyPrompt";
import type { ParsedUrl } from "../lib/ipc/generated/ParsedUrl";
import type { PasswordPrompt } from "../lib/ipc/generated/PasswordPrompt";
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
