import type { SessionMeta } from "./types";

/** A session as the backend would send it; override what a test cares about. */
export function meta(over: Partial<SessionMeta> & Pick<SessionMeta, "id">): SessionMeta {
  return {
    connectionId: "c1",
    tabId: null,
    name: "console",
    state: "idle",
    startedAt: 1_000_000,
    lastActivityAt: 1_000_000,
    runningSince: null,
    runningStatement: null,
    txStartedAt: null,
    txStatementCount: 0,
    txBreakdown: { select: 0, insert: 0, update: 0, delete: 0, other: 0 },
    txStatements: [],
    isolation: "READ COMMITTED",
    supportedIsolation: ["READ COMMITTED", "REPEATABLE READ", "SERIALIZABLE"],
    isolationNote: null,
    backendId: "28841",
    readOnly: false,
    sharedWith: [],
    waitingFor: null,
    ...over,
  };
}
