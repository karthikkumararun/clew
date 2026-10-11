/**
 * Typed bindings for the driver commands (`src-tauri/src/commands/{drivers,sessions}.rs`).
 *
 * The data types are generated from the Rust definitions by `cargo test` (ts-rs) into
 * `./generated`; edit the Rust types, not those files. Tauri converts Rust's snake_case argument
 * names to camelCase, while the fields *inside* payloads keep the casing serde gives them.
 */
import { Channel } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "./index";
import type { AppError } from "./index";
import type { DriverGroup } from "./generated/DriverGroup";
import type { ExecRequest } from "./generated/ExecRequest";
import type { ExecSummary } from "./generated/ExecSummary";
import type { FullValueRequest } from "./generated/FullValueRequest";
import type { HostKeyPrompt } from "./generated/HostKeyPrompt";
import type { NodePath } from "./generated/NodePath";
import type { OpenedSession } from "./generated/OpenedSession";
import type { ResolvedConfig } from "./generated/ResolvedConfig";
import type { ResultEvent } from "./generated/ResultEvent";
import type { SchemaSnapshot } from "./generated/SchemaSnapshot";
import type { ServerInfo } from "./generated/ServerInfo";
import type { TreeNode } from "./generated/TreeNode";
import type { Value } from "./generated/Value";

export type { AppError } from "./index";
export type { Capabilities } from "./generated/Capabilities";
export type { ColumnInfo } from "./generated/ColumnInfo";
export type { ColumnMeta } from "./generated/ColumnMeta";
export type { Dialect } from "./generated/Dialect";
export type { DriverError } from "./generated/DriverError";
export type { DriverFamily } from "./generated/DriverFamily";
export type { DriverGroup } from "./generated/DriverGroup";
export type { DriverMeta } from "./generated/DriverMeta";
export type { ErrorCode } from "./generated/ErrorCode";
export type { ExecRequest } from "./generated/ExecRequest";
export type { ExecSummary } from "./generated/ExecSummary";
export type { FormKind } from "./generated/FormKind";
export type { FullValueRequest } from "./generated/FullValueRequest";
export type { HostKeyPrompt } from "./generated/HostKeyPrompt";
export type { NodeKind } from "./generated/NodeKind";
export type { NodePath } from "./generated/NodePath";
export type { OpenedSession } from "./generated/OpenedSession";
export type { PathSegment } from "./generated/PathSegment";
export type { ResolvedConfig } from "./generated/ResolvedConfig";
export type { ResultEvent } from "./generated/ResultEvent";
export type { SchemaSnapshot } from "./generated/SchemaSnapshot";
export type { ServerInfo } from "./generated/ServerInfo";
export type { SnapshotColumn } from "./generated/SnapshotColumn";
export type { SnapshotSchema } from "./generated/SnapshotSchema";
export type { SnapshotTable } from "./generated/SnapshotTable";
export type { SshAuth } from "./generated/SshAuth";
export type { SshConfig } from "./generated/SshConfig";
export type { Target } from "./generated/Target";
export type { TlsConfig } from "./generated/TlsConfig";
export type { TlsMode } from "./generated/TlsMode";
export type { TreeNode } from "./generated/TreeNode";
export type { Value } from "./generated/Value";
export type { ValueKind } from "./generated/ValueKind";

/** Statement options; everything but `sql` defaults on the Rust side. */
export type ExecOptions = Pick<ExecRequest, "sql"> & Partial<Omit<ExecRequest, "sql">>;

export const DEFAULT_PAGE_SIZE = 500;

// ---- drivers ---------------------------------------------------------------------------------

/** Every registered driver with its metadata, grouped by family. */
export function driversList(): Promise<DriverGroup[]> {
  return invoke<DriverGroup[]>("drivers_list");
}

// ---- connections -----------------------------------------------------------------------------

/** Connect, run a trivial round-trip and report the server. Saves nothing. */
export function connectionTest(config: ResolvedConfig): Promise<ServerInfo> {
  return invoke<ServerInfo>("connection_test", { config });
}

/** Register a connection and open its metadata pool. */
export function connectionConnect(connectionId: string, config: ResolvedConfig): Promise<void> {
  return invoke<void>("connection_connect", { connectionId, config });
}

export function connectionDisconnect(connectionId: string): Promise<void> {
  return invoke<void>("connection_disconnect", { connectionId });
}

// ---- sessions --------------------------------------------------------------------------------

export function sessionOpen(connectionId: string): Promise<OpenedSession> {
  return invoke<OpenedSession>("session_open", { connectionId });
}

export function sessionClose(sessionId: string): Promise<void> {
  return invoke<void>("session_close", { sessionId });
}

// ---- queries ---------------------------------------------------------------------------------

/**
 * Execute a statement or script. Events arrive through `onEvent` as the server produces them;
 * the promise settles when the run ends. A failure is delivered as an `error` event *and*
 * rejects the promise.
 */
export function queryExecute(
  sessionId: string,
  request: ExecOptions,
  onEvent: (event: ResultEvent) => void,
  /** What a confirmation dialog was answered with (see `safetyCheck`). */
  confirmationToken?: string,
): Promise<ExecSummary | null> {
  const channel = new Channel<ResultEvent>();
  channel.onmessage = onEvent;
  return invoke<ExecSummary | null>("query_execute", {
    sessionId,
    request,
    ...(confirmationToken ? { confirmationToken } : {}),
    onEvent: channel,
  });
}

/** Pull more rows of an open result. Resolves with whether more rows remain. */
export function queryFetchMore(
  sessionId: string,
  resultId: number,
  count: number,
  onEvent: (event: ResultEvent) => void,
): Promise<boolean> {
  const channel = new Channel<ResultEvent>();
  channel.onmessage = onEvent;
  return invoke<boolean>("query_fetch_more", { sessionId, resultId, count, onEvent: channel });
}

export function queryCancel(sessionId: string): Promise<void> {
  return invoke<void>("query_cancel", { sessionId });
}

/** The untruncated value of a cell the grid received with `truncated: true`. */
export function valueFetchFull(sessionId: string, request: FullValueRequest): Promise<Value> {
  return invoke<Value>("value_fetch_full", { sessionId, request });
}

// ---- introspection ---------------------------------------------------------------------------

/** Children of `path`; the empty path is the connection root. */
export function introspectChildren(connectionId: string, path: NodePath): Promise<TreeNode[]> {
  return invoke<TreeNode[]>("introspect_children", { connectionId, path });
}

/** The `CREATE` statement of a table, view, routine or trigger (where the driver supports it). */
export function introspectDdl(connectionId: string, path: NodePath): Promise<string> {
  return invoke<string>("introspect_ddl", { connectionId, path });
}

/** Schemas, tables, columns and functions in one call, for completion. */
export function completionSnapshot(
  connectionId: string,
  database: string,
): Promise<SchemaSnapshot> {
  return invoke<SchemaSnapshot>("completion_snapshot", { connectionId, database });
}

// ---- SSH host keys ---------------------------------------------------------------------------

/** Called when an SSH bastion presents a key that is not in any known-hosts file. */
export function onHostKeyPrompt(handler: (prompt: HostKeyPrompt) => void): Promise<() => void> {
  return listen<HostKeyPrompt>("host_key_prompt", (e) => handler(e.payload));
}

/** Accept or reject the key shown in a `host_key_prompt`. */
export function hostKeyAnswer(promptId: string, accept: boolean): Promise<boolean> {
  return invoke<boolean>("host_key_answer", { promptId, accept });
}

export function isAppError(e: unknown): e is AppError {
  return typeof e === "object" && e !== null && "code" in e && "message" in e;
}
