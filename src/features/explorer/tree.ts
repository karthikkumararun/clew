/**
 * Pure tree model for the explorer: node ids, the normalized node entries and the derivation of
 * the flat list of visible rows (with filtering). No React, no IPC, so it is easy to test.
 */
import type { ColumnInfo, NodeKind, NodePath } from "../../lib/ipc/drivers";
import type { Connection, ConnectionsFile, Group } from "../../connections/api";

export type LoadState = "idle" | "loading" | "loaded" | "error";

/** `scripts` and `script` are client-side nodes: a connection's Scripts folder and its files. */
export type EntryKind = NodeKind | "connection" | "scripts" | "script";

/** One node of a connection's introspection tree (the connection itself is the root entry). */
export interface NodeEntry {
  id: string;
  connId: string;
  parentId: string | null;
  kind: EntryKind;
  name: string;
  path: NodePath;
  detail?: string;
  hasChildren: boolean;
  column?: ColumnInfo;
  /** For a `script` node: the file it stands for. */
  file?: { path: string; relPath: string };
  childIds: string[];
  state: LoadState;
  error?: string;
}

const esc = (s: string) => s.replace(/%/g, "%25").replace(/\//g, "%2F");

/** Stable id of a node: `<connId>/db:analytics/schema:public/group:tables/table:orders/...`. */
export function nodeId(connId: string, path: NodePath): string {
  return [connId, ...path.map((s) => `${s.kind}:${esc(s.name)}`)].join("/");
}

/** Id of the Scripts node under a connection, and of a file under it. */
export const scriptsNodeId = (connId: string) => `${connId}/scripts:Scripts`;
export const scriptNodeId = (connId: string, relPath: string) =>
  `${scriptsNodeId(connId)}/script:${esc(relPath)}`;

export function rootEntry(connId: string): NodeEntry {
  return {
    id: connId,
    connId,
    parentId: null,
    kind: "connection",
    name: "",
    path: [],
    hasChildren: true,
    childIds: [],
    state: "idle",
  };
}

/** The connection id an id belongs to. */
export function connOfId(id: string): string {
  const i = id.indexOf("/");
  return i < 0 ? id : id.slice(0, i);
}

export type Row =
  | { type: "group"; id: string; label: string; collapsed: boolean; groupId: string | null }
  | {
      type: "connection";
      id: string;
      conn: Connection;
      expanded: boolean;
      connected: boolean;
      loading: boolean;
      match: Match | null;
    }
  | {
      type: "node";
      id: string;
      entry: NodeEntry;
      level: number;
      expanded: boolean;
      loading: boolean;
      match: Match | null;
    }
  | { type: "error"; id: string; parentId: string; message: string; level: number }
  | { type: "more"; id: string; parentId: string; hidden: number; level: number };

export type Match = [start: number, end: number];

export interface FlattenInput {
  file: ConnectionsFile;
  connected: Record<string, unknown>;
  nodes: Record<string, NodeEntry>;
  expanded: ReadonlySet<string>;
  collapsedGroups: ReadonlySet<string>;
  filter: string;
}

export const UNGROUPED = "__ungrouped__";

/** Default groups when the user has made none, most careful first. */
const ENVIRONMENT_ORDER = ["production", "staging", "development", "local"] as const;

/** Cap on children rendered per node; a hint row tells the user to filter. */
export const CHILD_CAP = 5000;

function findMatch(name: string, needle: string): Match | null {
  if (!needle) return null;
  const i = name.toLowerCase().indexOf(needle);
  return i < 0 ? null : [i, i + needle.length];
}

function sortedGroups(file: ConnectionsFile): Group[] {
  return [...file.groups].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Connections bucketed by group id (`null` for ungrouped or an unknown group). */
export function bucketConnections(file: ConnectionsFile): Map<string | null, Connection[]> {
  const known = new Set(file.groups.map((g) => g.id));
  const by = new Map<string | null, Connection[]>();
  for (const c of file.connections) {
    const key = c.groupId && known.has(c.groupId) ? c.groupId : null;
    by.set(key, [...(by.get(key) ?? []), c]);
  }
  return by;
}

/**
 * Which loaded nodes match the filter, and which only survive as an ancestor of a match.
 * Returns `null` when there is no filter.
 */
function filterSets(input: FlattenInput, needle: string) {
  const matched = new Set<string>();
  const keep = new Set<string>();
  const keepAncestors = (id: string) => {
    let cur: string | null = id;
    while (cur && !keep.has(cur)) {
      keep.add(cur);
      cur = input.nodes[cur]?.parentId ?? null;
    }
  };
  for (const c of input.file.connections) {
    if (c.name.toLowerCase().includes(needle)) {
      matched.add(c.id);
      keep.add(c.id);
    }
  }
  for (const e of Object.values(input.nodes)) {
    if (e.kind === "connection") continue;
    if (e.name.toLowerCase().includes(needle)) {
      matched.add(e.id);
      keepAncestors(e.id);
    }
  }
  return { matched, keep };
}

/** The visible rows, top to bottom. Expansion is O(visible). */
export function flatten(input: FlattenInput): Row[] {
  const needle = input.filter.trim().toLowerCase();
  const filtering = needle.length > 0;
  const sets = filtering ? filterSets(input, needle) : null;
  const rows: Row[] = [];

  const pushNode = (id: string, level: number) => {
    const e = input.nodes[id];
    if (!e) return;
    if (sets && !sets.keep.has(id)) return;
    // While filtering, ancestors of a match stay open; matched leaves-of-interest stay closed.
    const hasKeptChild = sets ? e.childIds.some((c) => sets.keep.has(c)) : false;
    const expanded = sets ? hasKeptChild : input.expanded.has(id);
    rows.push({
      type: "node",
      id,
      entry: e,
      level,
      expanded,
      loading: e.state === "loading",
      match: sets?.matched.has(id) ? findMatch(e.name, needle) : null,
    });
    if (!expanded) return;
    if (e.state === "error") {
      rows.push({
        type: "error",
        id: `${id}#error`,
        parentId: id,
        message: e.error ?? "Couldn't load this node",
        level: level + 1,
      });
      return;
    }
    const ids = sets ? e.childIds : e.childIds.slice(0, CHILD_CAP);
    for (const child of ids) pushNode(child, level + 1);
    if (ids.length < e.childIds.length) {
      rows.push({
        type: "more",
        id: `${id}#more`,
        parentId: id,
        hidden: e.childIds.length - ids.length,
        level: level + 1,
      });
    }
  };

  const pushConnection = (c: Connection) => {
    if (sets && !sets.keep.has(c.id)) return;
    const root = input.nodes[c.id];
    const connected = !!input.connected[c.id];
    const hasKeptChild = sets && root ? root.childIds.some((k) => sets.keep.has(k)) : false;
    const expanded = sets
      ? hasKeptChild
      : connected && input.expanded.has(c.id) && root !== undefined;
    rows.push({
      type: "connection",
      id: c.id,
      conn: c,
      expanded,
      connected,
      loading: root?.state === "loading",
      match: sets?.matched.has(c.id) ? findMatch(c.name, needle) : null,
    });
    if (!expanded || !root) return;
    if (root.state === "error") {
      rows.push({
        type: "error",
        id: `${c.id}#error`,
        parentId: c.id,
        message: root.error ?? "Couldn't load this connection",
        level: 1,
      });
      return;
    }
    for (const child of root.childIds) pushNode(child, 1);
  };

  const buckets = bucketConnections(input.file);
  // With no groups of their own, connections sit under default groups by environment.
  const byEnvironment = input.file.groups.length === 0;
  const sections = byEnvironment
    ? ENVIRONMENT_ORDER.map((env) => ({
        key: `env:${env}`,
        label: env.toUpperCase(),
        groupId: null as string | null,
        items: (buckets.get(null) ?? []).filter((c) => c.environment === env),
      }))
    : [
        ...sortedGroups(input.file).map((g) => ({
          key: g.id,
          label: g.name,
          groupId: g.id as string | null,
          items: buckets.get(g.id) ?? [],
        })),
        { key: UNGROUPED, label: "Ungrouped", groupId: null, items: buckets.get(null) ?? [] },
      ];
  const showHeads = true;
  for (const s of sections) {
    const visibleItems = sets ? s.items.filter((c) => sets.keep.has(c.id)) : s.items;
    if (
      sets
        ? visibleItems.length === 0
        : s.items.length === 0 && (byEnvironment || s.key === UNGROUPED)
    ) {
      continue;
    }
    const collapsed = !sets && input.collapsedGroups.has(s.key);
    if (showHeads) {
      rows.push({
        type: "group",
        id: `group:${s.key}`,
        label: s.label,
        collapsed,
        groupId: s.groupId,
      });
    }
    if (collapsed) continue;
    for (const c of visibleItems) pushConnection(c);
  }
  return rows;
}

/** Index of the next row after `from` whose label starts with `prefix` (wraps around). */
export function typeAheadIndex(
  rows: Row[],
  from: number,
  prefix: string,
  labelOf: (r: Row) => string,
): number {
  const p = prefix.toLowerCase();
  if (!p) return -1;
  const n = rows.length;
  // A repeated single letter cycles; a longer prefix may match the current row.
  const start = p.length > 1 ? from : from + 1;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    if (labelOf(rows[i]).toLowerCase().startsWith(p)) return i;
  }
  return -1;
}

export function rowLabel(r: Row): string {
  switch (r.type) {
    case "group":
      return r.label;
    case "connection":
      return r.conn.name;
    case "node":
      return r.entry.name;
    case "error":
    case "more":
      return "";
  }
}
