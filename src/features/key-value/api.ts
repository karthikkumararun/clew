import { invoke } from "../../lib/ipc";
import type { GuardReport } from "../../lib/ipc/generated/GuardReport";
import type { KvReply } from "../../lib/ipc/generated/KvReply";
import type { KvRequest } from "../../lib/ipc/generated/KvRequest";

export type { KvReply, KvRequest };
export type { KeyDetail } from "../../lib/ipc/generated/KeyDetail";
export type { KeyInfo } from "../../lib/ipc/generated/KeyInfo";
export type { RedisValue } from "../../lib/ipc/generated/RedisValue";

/** Run a Redis request. `token` answers a confirmation dialog (see `kvSafetyCheck`). */
export const kvCall = (sessionId: string, request: KvRequest, token?: string) =>
  invoke<KvReply>("kv_call", { sessionId, request, ...(token ? { token } : {}) });

/** What the safeguards say about a console line before it is sent. */
export const kvSafetyCheck = (sessionId: string, line: string) =>
  invoke<GuardReport>("safety_check", { sessionId, sql: line, script: false });
