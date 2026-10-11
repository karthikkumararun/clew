import { nodeId } from "../explorer/tree";

export const KEYS_KIND = "keys";

/** What a key-browser tab keeps. */
export interface KeysTabState {
  connectionId: string;
  /** Logical database, 0–15. */
  db: number;
  /** Glob filter (`session:*`); empty means every key. */
  pattern: string;
  /** The key open in the viewer. */
  selected: string | null;
  /** The tab's open session; transient. */
  sessionId?: string;
}

export type KeysTab = import("../../shell/registry/tabKinds").Tab<KeysTabState>;

export const keysKey = (connectionId: string, db: number) =>
  `keys:${nodeId(connectionId, [{ kind: "database", name: `db${db}` }])}`;

export function serializeKeys(s: KeysTabState): KeysTabState {
  const { sessionId: _session, ...persisted } = s;
  void _session;
  return persisted;
}

export function deserializeKeys(raw: unknown): KeysTabState {
  const r = (raw ?? {}) as Partial<KeysTabState>;
  if (typeof r.connectionId !== "string") throw new Error("a key browser needs a connection");
  return {
    connectionId: r.connectionId,
    db: typeof r.db === "number" && r.db >= 0 ? Math.floor(r.db) : 0,
    pattern: typeof r.pattern === "string" ? r.pattern : "",
    selected: typeof r.selected === "string" ? r.selected : null,
  };
}
