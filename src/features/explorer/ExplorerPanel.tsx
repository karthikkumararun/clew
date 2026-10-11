import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent, ReactNode } from "react";
import { Button, IconButton } from "../../components/Button";
import { Menu } from "../../components/Menu";
import type { MenuItem } from "../../components/Menu";
import { ChevronUp, Plus, Refresh } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import type { Connection } from "../../connections/api";
import { formatShortcut } from "../../lib/platform";
import { runCommand } from "../../shell/registry/commands";
import { useExplorer } from "./explorerStore";
import { connectionMenu, nodeMenu } from "./menus";
import { isTableLike } from "./names";
import { TreeRow, depthOf } from "./TreeRow";
import { flatten, rowLabel, typeAheadIndex } from "./tree";
import type { Row } from "./tree";
import styles from "./ExplorerPanel.module.css";

const ROW_HEIGHT = 24;
const TYPE_AHEAD_MS = 700;

interface MenuState {
  rowId: string;
  x: number;
  y: number;
}

/** The id to act on for a row: the node id, the connection id, or the group header. */
const rowKey = (r: Row) => r.id;

/** Default action of a row (Enter / double-click). */
function activate(row: Row) {
  const ex = useExplorer.getState();
  if (row.type === "connection") void runCommand("connection.open", row.id);
  else if (row.type === "group") ex.toggleGroup(row.id.slice("group:".length));
  else if (row.type === "node" && isTableLike(row.entry.kind)) {
    void runCommand("explorer.openData", row.id);
  } else if (row.type === "node" && row.entry.kind === "script") {
    void runCommand("explorer.openScript", row.id);
  } else if (row.type === "node") void ex.toggle(row.id);
}

function canExpand(row: Row): boolean {
  if (row.type === "group" || row.type === "connection") return true;
  return row.type === "node" && row.entry.hasChildren;
}

function isOpen(row: Row): boolean {
  return (
    (row.type === "group" && !row.collapsed) ||
    (row.type !== "group" && "expanded" in row && row.expanded)
  );
}

function toggleRow(row: Row) {
  const ex = useExplorer.getState();
  if (row.type === "group") ex.toggleGroup(row.id.slice("group:".length));
  else if (row.type === "connection" || row.type === "node") void ex.toggle(row.id);
}

export function ExplorerPanel({ extra }: { extra?: ReactNode }) {
  const file = useConnections((s) => s.file);
  const connected = useConnections((s) => s.connected);
  const nodes = useExplorer((s) => s.nodes);
  const expanded = useExplorer((s) => s.expanded);
  const collapsedGroups = useExplorer((s) => s.collapsedGroups);
  const selectedId = useExplorer((s) => s.selectedId);
  const filter = useExplorer((s) => s.filter);
  const counts = useExplorer((s) => s.counts);

  const parentRef = useRef<HTMLDivElement>(null);
  const typeBuffer = useRef({ text: "", at: 0 });
  const dragId = useRef<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);

  const rows = useMemo(
    () => flatten({ file, connected, nodes, expanded, collapsedGroups, filter }),
    [file, connected, nodes, expanded, collapsedGroups, filter],
  );
  const shift = file.groups.length > 0 ? 0 : 1;
  const selectedIndex = rows.findIndex((r) => r.id === selectedId);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Keep the selected row in view when selection changes from outside (reveal, tab switch).
  useEffect(() => {
    if (selectedIndex >= 0) virtualizer.scrollToIndex(selectedIndex, { align: "auto" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const select = (row: Row | undefined) => {
    if (row && row.type !== "error" && row.type !== "more") useExplorer.getState().select(row.id);
  };
  const moveTo = (index: number) => {
    const i = Math.max(0, Math.min(rows.length - 1, index));
    select(rows[i]);
    virtualizer.scrollToIndex(i, { align: "auto" });
  };

  const openMenuFor = (row: Row, x: number, y: number) => {
    if (row.type === "error" || row.type === "more") return;
    setMenu({ rowId: row.id, x, y });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const row = rows[selectedIndex];
    const idx = selectedIndex < 0 ? 0 : selectedIndex;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(selectedIndex < 0 ? 0 : idx + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveTo(idx - 1);
        return;
      case "Home":
        e.preventDefault();
        moveTo(0);
        return;
      case "End":
        e.preventDefault();
        moveTo(rows.length - 1);
        return;
      case "ArrowRight":
        e.preventDefault();
        if (!row || !canExpand(row)) return;
        if (!isOpen(row)) toggleRow(row);
        else if (rows[idx + 1] && depthOf(rows[idx + 1], shift) > depthOf(row, shift))
          moveTo(idx + 1);
        return;
      case "ArrowLeft": {
        e.preventDefault();
        if (!row) return;
        if (canExpand(row) && isOpen(row)) {
          toggleRow(row);
          return;
        }
        const depth = depthOf(row, shift);
        for (let i = idx - 1; i >= 0; i--) {
          if (depthOf(rows[i], shift) < depth) {
            moveTo(i);
            return;
          }
        }
        return;
      }
      case "Enter":
        e.preventDefault();
        if (row) activate(row);
        return;
      case "F2":
        if (row?.type === "connection") void runCommand("connection.rename", row.id);
        return;
      case "Delete":
        if (row?.type === "connection") void runCommand("connection.delete", row.id);
        return;
      case "ContextMenu":
      case "F10":
        if (e.key === "F10" && !e.shiftKey) return;
        e.preventDefault();
        if (row) {
          const el = parentRef.current?.querySelector(`[data-index="${idx}"]`);
          const r = el?.getBoundingClientRect();
          openMenuFor(row, (r?.left ?? 0) + 24, r?.bottom ?? 0);
        }
        return;
    }
    // Type-ahead: letters jump to the next visible row starting with them.
    if (e.key.length === 1 && e.key !== " ") {
      const now = Date.now();
      const buf = typeBuffer.current;
      buf.text = now - buf.at > TYPE_AHEAD_MS ? e.key : buf.text + e.key;
      buf.at = now;
      const hit = typeAheadIndex(rows, idx, buf.text, rowLabel);
      if (hit >= 0) moveTo(hit);
    }
  };

  // ---- drag a connection onto another group ---------------------------------------------
  const groupIdOf = (row: Row): string | null | undefined => {
    if (row.type === "group")
      return row.id.slice("group:".length) === "__ungrouped__"
        ? null
        : row.id.slice("group:".length);
    if (row.type === "connection") return row.conn.groupId ?? null;
    return undefined;
  };
  const dragHandlers = (row: Row) => ({
    onDragStart: (e: DragEvent) => {
      if (row.type !== "connection") return;
      dragId.current = row.id;
      e.dataTransfer?.setData("text/plain", row.id);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    },
    onDragOver: (e: DragEvent) => {
      if (!dragId.current || groupIdOf(row) === undefined) return;
      e.preventDefault();
      setDropOn(row.id);
    },
    onDragLeave: () => setDropOn((cur) => (cur === row.id ? null : cur)),
    onDrop: (e: DragEvent) => {
      const id = dragId.current;
      const to = groupIdOf(row);
      dragId.current = null;
      setDropOn(null);
      if (!id || to === undefined) return;
      e.preventDefault();
      const c = file.connections.find((x) => x.id === id);
      if (c && (c.groupId ?? null) !== to) void useConnections.getState().move(id, to);
    },
  });

  // ---- context menu --------------------------------------------------------------------
  let menuItems: MenuItem[] = [];
  let runMenu: (id: string) => void = () => {};
  if (menu) {
    const row = rows.find((r) => r.id === menu.rowId);
    if (row?.type === "connection") {
      const c: Connection = row.conn;
      menuItems = connectionMenu(c, file.groups, row.connected);
      runMenu = (id) => {
        const s = useConnections.getState();
        if (id === "console.new") void runCommand("connection.open", c.id);
        else if (id === "move:__new__") s.setModal({ kind: "newGroup", moveConnectionId: c.id });
        else if (id.startsWith("move:")) void s.move(c.id, id.slice(5) || null);
        else if (id.startsWith("env:"))
          void s.setEnvironment(c.id, id.slice(4) as Connection["environment"]);
        else void runCommand(id, c.id);
      };
    } else if (row?.type === "node") {
      menuItems = nodeMenu(
        row.entry,
        file.connections.find((c) => c.id === row.entry.connId)?.driver,
      );
      runMenu = (id) => void runCommand(id, row.id);
    } else if (row?.type === "group" && row.groupId) {
      const gid = row.groupId;
      menuItems = [
        { id: "rename", label: "Rename group…" },
        { id: "delete", label: "Delete group" },
      ];
      runMenu = (id) =>
        useConnections
          .getState()
          .setModal({ kind: id === "rename" ? "renameGroup" : "deleteGroup", id: gid });
    }
  }

  const empty = file.connections.length === 0;

  return (
    <aside className={styles.panel} aria-label="Explorer">
      <div className={styles.header}>
        <span>Explorer</span>
        <div className={styles.actions}>
          <IconButton aria-label="New connection" onClick={() => void runCommand("connection.new")}>
            <Plus size={14} />
          </IconButton>
          <IconButton
            aria-label="Refresh schema"
            onClick={() => void runCommand("explorer.refresh")}
          >
            <Refresh size={14} />
          </IconButton>
          <IconButton
            aria-label="Collapse all"
            onClick={() => void runCommand("explorer.collapseAll")}
          >
            <ChevronUp size={14} />
          </IconButton>
        </div>
      </div>
      {empty ? (
        <div className={styles.empty}>
          <p>No connections yet.</p>
          <Button variant="primary" onClick={() => void runCommand("connection.new")}>
            <Plus size={12} />
            New connection
          </Button>
          <button
            type="button"
            className={styles.link}
            onClick={() => void runCommand("connection.import")}
          >
            Import…
          </button>
        </div>
      ) : (
        <>
          <div className={styles.filterWrap}>
            <label htmlFor="tree-filter" className="sr-only">
              Filter explorer
            </label>
            <input
              id="tree-filter"
              className={styles.filter}
              placeholder="Filter objects…"
              value={filter}
              onChange={(e) => useExplorer.getState().setFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") useExplorer.getState().setFilter("");
                else if (e.key === "ArrowDown") {
                  e.preventDefault();
                  parentRef.current?.focus();
                  if (selectedIndex < 0) moveTo(0);
                }
              }}
            />
          </div>
          <div
            ref={parentRef}
            className={styles.tree}
            role="tree"
            aria-label="Database explorer"
            tabIndex={0}
            data-explorer-tree
            aria-activedescendant={selectedIndex >= 0 ? `ex-row-${selectedIndex}` : undefined}
            onKeyDown={onKeyDown}
          >
            {rows.length === 0 && filter.trim() ? (
              <p className={styles.empty}>
                No loaded objects match — use {formatShortcut("Mod+K")} to search everything
              </p>
            ) : (
              <div className={styles.inner} style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((v) => {
                  const row = rows[v.index];
                  const doMenu = (x: number, y: number) => openMenuFor(row, x, y);
                  return (
                    <TreeRow
                      key={rowKey(row)}
                      row={row}
                      index={v.index}
                      depth={depthOf(row, shift)}
                      selected={row.id === selectedId}
                      style={{ transform: `translateY(${v.start}px)` }}
                      exactCount={counts[row.id]}
                      dropTarget={dropOn === row.id}
                      onSelect={() => select(row)}
                      onToggle={() => toggleRow(row)}
                      onActivate={() => activate(row)}
                      onMenu={doMenu}
                      onRetry={() => {
                        if (row.type === "error") void useExplorer.getState().load(row.parentId);
                      }}
                      {...dragHandlers(row)}
                    />
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
      {extra}
      {menu && menuItems.length > 0 ? (
        <>
          <div className={styles.menuScrim} onMouseDown={() => setMenu(null)} aria-hidden="true" />
          <div className={styles.menuHost} style={{ left: menu.x, top: menu.y }}>
            <Menu
              aria-label="Explorer actions"
              items={menuItems}
              onClose={() => setMenu(null)}
              onSelect={(id) => {
                setMenu(null);
                runMenu(id);
              }}
            />
          </div>
        </>
      ) : null}
    </aside>
  );
}
