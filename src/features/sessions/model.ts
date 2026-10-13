import type { Connection } from "../../connections/api";
import type { SessionMeta } from "./types";
import { inTransaction } from "../../stores/sessionsStore";

export interface ConnectionNode {
  connection: Connection;
  sessions: SessionMeta[];
  /** Listed as disconnected: all its sessions closed and the connection is not live. */
  disconnected: boolean;
}

/**
 * The tree's connections: those connected or holding sessions, plus the ones just deactivated
 * (they stay listed as disconnected). A filter keeps only sessions whose names match, with their
 * connections.
 */
export function buildNodes(
  connections: Connection[],
  sessions: SessionMeta[],
  connected: Record<string, unknown>,
  deactivated: string[],
  filter: string,
): ConnectionNode[] {
  const q = filter.trim().toLowerCase();
  const out: ConnectionNode[] = [];
  for (const connection of connections) {
    const own = sessions.filter((s) => s.connectionId === connection.id);
    const live = connection.id in connected;
    if (!live && own.length === 0 && !deactivated.includes(connection.id)) continue;
    const shown = q ? own.filter((s) => s.name.toLowerCase().includes(q)) : own;
    if (q && shown.length === 0) continue;
    out.push({ connection, sessions: shown, disconnected: !live && own.length === 0 });
  }
  return out;
}

export const hasTransaction = (nodes: ConnectionNode[]) =>
  nodes.some((n) => n.sessions.some(inTransaction));

/** One keyboard stop in the tree. */
export type Stop =
  | { kind: "connection"; id: string; level: 1; parent: null }
  | { kind: "session"; id: string; level: 2; parent: string }
  | { kind: "shared"; id: string; sessionId: string; tabId: string; level: 3; parent: string };

/** The visible rows in order, honouring collapsed connections. */
export function stopsOf(
  nodes: ConnectionNode[],
  collapsed: string[],
  sharedTabs: (session: SessionMeta) => { id: string }[],
): Stop[] {
  const out: Stop[] = [];
  for (const n of nodes) {
    out.push({ kind: "connection", id: n.connection.id, level: 1, parent: null });
    if (collapsed.includes(n.connection.id)) continue;
    for (const s of n.sessions) {
      out.push({ kind: "session", id: s.id, level: 2, parent: n.connection.id });
      for (const t of sharedTabs(s)) {
        out.push({
          kind: "shared",
          id: `${s.id}:${t.id}`,
          sessionId: s.id,
          tabId: t.id,
          level: 3,
          parent: s.id,
        });
      }
    }
  }
  return out;
}
