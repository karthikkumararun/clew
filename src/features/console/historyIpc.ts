import { invoke } from "../../lib/ipc";
import type { HistoryEntry } from "../../lib/ipc/generated/HistoryEntry";
import type { HistoryPage } from "../../lib/ipc/generated/HistoryPage";

export type { HistoryEntry, HistoryPage };

/** A connection's executed statements, newest first. */
export const historyList = (connectionId: string, query?: string, before?: number | null) =>
  invoke<HistoryPage>("history_list", {
    connectionId,
    query: query || null,
    before: before ?? null,
  });

/** Delete one connection's history, or everyone's when no id is given. Resolves with the count. */
export const historyClear = (connectionId?: string) =>
  invoke<number>("history_clear", { connectionId: connectionId ?? null });
