/**
 * The session contract, as generated from the Rust side (`SessionMeta`, `SessionEvent`; camelCase
 * on the wire). Timestamps are milliseconds since the epoch.
 */
export type { SessionEvent } from "../../lib/ipc/generated/SessionEvent";
export type { SessionMeta } from "../../lib/ipc/generated/SessionMeta";
export type { SessionState } from "../../lib/ipc/generated/SessionState";
export type { TxBreakdown } from "../../lib/ipc/generated/TxBreakdown";
export type { TxStatement } from "../../lib/ipc/generated/TxStatement";

/** What to do with open transactions when sessions close. */
export type TxAction = "commit" | "rollback";
