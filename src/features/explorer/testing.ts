import type { Connection, ConnectionsFile } from "../../connections/api";
import { newDraft, toConnection } from "../../connections/draft";
import type { NodeKind, NodePath, TreeNode } from "../../lib/ipc/drivers";

export function conn(id: string, name: string, extra: Partial<Connection> = {}): Connection {
  return { ...toConnection({ ...newDraft("postgres"), id, name, host: "h" }), ...extra };
}

export const file = (
  connections: Connection[],
  groups: ConnectionsFile["groups"] = [],
): ConnectionsFile => ({ version: 1, groups, connections });

/** A `TreeNode` as the Rust side serialises it. */
export function tn(
  parent: NodePath,
  kind: NodeKind,
  name: string,
  over: Partial<TreeNode> = {},
): TreeNode {
  return {
    path: [...parent, { kind, name }],
    kind,
    name,
    has_children: kind !== "column",
    ...over,
  };
}

/**
 * jsdom has no layout, so the virtualized list would render nothing. Give the scroll container a
 * size and stub ResizeObserver; returns a function that undoes it.
 */
export function stubLayout(width = 300, height = 600): () => void {
  const proto = HTMLElement.prototype;
  const rect = proto.getBoundingClientRect;
  const offH = Object.getOwnPropertyDescriptor(proto, "offsetHeight");
  const offW = Object.getOwnPropertyDescriptor(proto, "offsetWidth");
  const hadRO = "ResizeObserver" in globalThis;
  Object.defineProperty(proto, "offsetHeight", { configurable: true, get: () => height });
  Object.defineProperty(proto, "offsetWidth", { configurable: true, get: () => width });
  proto.getBoundingClientRect = function (this: HTMLElement) {
    return this.hasAttribute("data-explorer-tree")
      ? ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height } as DOMRect)
      : rect.call(this);
  };
  if (!hadRO) {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
  return () => {
    proto.getBoundingClientRect = rect;
    if (offH) Object.defineProperty(proto, "offsetHeight", offH);
    else delete (proto as unknown as Record<string, unknown>).offsetHeight;
    if (offW) Object.defineProperty(proto, "offsetWidth", offW);
    else delete (proto as unknown as Record<string, unknown>).offsetWidth;
    if (!hadRO) delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  };
}

import { nodeId, rootEntry } from "./tree";
import type { NodeEntry } from "./tree";

type Spec = {
  kind: NodeKind;
  name: string;
  detail?: string;
  column?: { type_name: string; primary_key?: boolean; foreign_key?: string };
  children?: Spec[];
};

/**
 * Build loaded node entries for one connection from a nested spec, as if every level had been
 * expanded. Returns the node map and the ids of everything with children (to mark expanded).
 */
export function seedNodes(connId: string, tree: Spec[]) {
  const nodes: Record<string, NodeEntry> = { [connId]: { ...rootEntry(connId), state: "loaded" } };
  const expandable: string[] = [connId];
  const walk = (specs: Spec[], parentId: string, parentPath: NodePath) => {
    for (const s of specs) {
      const path: NodePath = [...parentPath, { kind: s.kind, name: s.name }];
      const id = nodeId(connId, path);
      nodes[id] = {
        id,
        connId,
        parentId,
        kind: s.kind,
        name: s.name,
        path,
        detail: s.detail,
        hasChildren: !!s.children?.length || s.kind !== "column",
        column: s.column && {
          type_name: s.column.type_name,
          nullable: true,
          default: null,
          primary_key: !!s.column.primary_key,
          foreign_key: s.column.foreign_key ?? null,
        },
        childIds: [],
        state: s.children ? "loaded" : "idle",
      };
      nodes[parentId].childIds.push(id);
      if (s.children) {
        expandable.push(id);
        walk(s.children, id, path);
      }
    }
  };
  walk(tree, connId, []);
  return { nodes, expandable };
}

export const SAMPLE: Spec[] = [
  {
    kind: "database",
    name: "analytics",
    children: [
      {
        kind: "schema",
        name: "public",
        children: [
          {
            kind: "group",
            name: "tables",
            detail: "3",
            children: [
              {
                kind: "table",
                name: "orders",
                detail: "12.4k",
                children: [
                  { kind: "column", name: "id", column: { type_name: "int8", primary_key: true } },
                  {
                    kind: "column",
                    name: "user_id",
                    detail: "int8 → users",
                    column: { type_name: "int8", foreign_key: "users.id" },
                  },
                  { kind: "column", name: "status", column: { type_name: "order_status" } },
                ],
              },
              { kind: "table", name: "order_items", detail: "98k" },
              { kind: "table", name: "users", detail: "1.2k" },
            ],
          },
          { kind: "group", name: "views", detail: "3" },
        ],
      },
    ],
  },
  { kind: "database", name: "billing" },
];
