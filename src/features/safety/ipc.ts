import { invoke } from "../../lib/ipc";
import type { ChangeRequest } from "../../lib/ipc/generated/ChangeRequest";
import type { GuardReport } from "../../lib/ipc/generated/GuardReport";

export type { GuardReport };
export type { GuardStatement } from "../../lib/ipc/generated/GuardStatement";
export type { Decision } from "../../lib/ipc/generated/Decision";

/** Ask the guard about SQL before it is run. */
export const safetyCheck = (sessionId: string, sql: string, script: boolean) =>
  invoke<GuardReport>("safety_check", { sessionId, sql, script });

/** Ask the guard about staged table edits. */
export const safetyCheckChanges = (
  connectionId: string,
  sessionId: string,
  request: ChangeRequest,
) => invoke<GuardReport>("safety_check_changes", { connectionId, sessionId, request });

export const sessionReadOnly = (sessionId: string) =>
  invoke<boolean>("session_read_only", { sessionId });

/** Switch one session to read-write (or back). Lasts until the session closes. */
export const setSessionReadOnly = (sessionId: string, readOnly: boolean) =>
  invoke<void>("session_set_read_only", { sessionId, readOnly });
