import { Channel } from "@tauri-apps/api/core";
import { invoke } from "../../lib/ipc";
import type { DocReply } from "../../lib/ipc/generated/DocReply";
import type { DocRequest } from "../../lib/ipc/generated/DocRequest";
import type { GuardReport } from "../../lib/ipc/generated/GuardReport";
import type { ResultEvent } from "../../lib/ipc/generated/ResultEvent";
import type { EJson } from "./ejson";

export type { DocReply, DocRequest };
export type { CollectionInfo } from "../../lib/ipc/generated/CollectionInfo";
export type { FieldCheck } from "../../lib/ipc/generated/FieldCheck";
export type { IndexInfo } from "../../lib/ipc/generated/IndexInfo";
export type { SchemaField } from "../../lib/ipc/generated/SchemaField";
export type { ExportFormat } from "../../lib/ipc/generated/ExportFormat";

export type DocEvent = Extract<ResultEvent, { event: "documents" }>;

/**
 * Run a MongoDB request. Documents of a `find` / `aggregate` / console command stream through
 * `onDocuments`; the reply says what happened. `token` answers a confirmation dialog.
 */
export function docCall(
  sessionId: string,
  request: DocRequest,
  onDocuments?: (resultId: number, docs: EJson[]) => void,
  token?: string,
): Promise<DocReply> {
  const channel = new Channel<ResultEvent>();
  channel.onmessage = (e) => {
    if (e.event === "documents") onDocuments?.(e.result_id, e.docs as EJson[]);
  };
  return invoke<DocReply>("doc_call", {
    sessionId,
    request,
    ...(token ? { token } : {}),
    onEvent: channel,
  });
}

/** What the safeguards say about a request before it is sent. */
export const docSafetyCheck = (sessionId: string, request: DocRequest) =>
  invoke<GuardReport>("doc_safety_check", { sessionId, request });

/** Pull the next page of an open cursor. Resolves with whether more remain. */
export function docFetchMore(
  sessionId: string,
  resultId: number,
  count: number,
  onDocuments: (docs: EJson[]) => void,
): Promise<boolean> {
  const channel = new Channel<ResultEvent>();
  channel.onmessage = (e) => {
    if (e.event === "documents") onDocuments(e.docs as EJson[]);
  };
  return invoke<boolean>("query_fetch_more", { sessionId, resultId, count, onEvent: channel });
}

/** Ask where to save an export; `null` when the dialog is cancelled. */
export const exportPickPath = (defaultName: string, extension: string) =>
  invoke<string | null>("export_pick_path", { defaultName, extension });
