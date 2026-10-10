import { useMemo, useState } from "react";
import type { KeyboardEvent, MouseEvent } from "react";
import { DriverBadge, EnvDot } from "../components/Badge";
import { Menu } from "../components/Menu";
import type { MenuItem } from "../components/Menu";
import { ChevronDown, ChevronRight, Plus } from "../components/icons";
import { runCommand } from "../shell/registry/commands";
import type { Connection, Group } from "./api";
import { useConnections } from "./connectionsStore";
import { BADGE_ENV, badgeDriver } from "./display";
import { ENVIRONMENTS } from "./draft";
import styles from "./ConnectionList.module.css";

type MenuTarget =
  | { kind: "connection"; id: string; x: number; y: number }
  | { kind: "group"; id: string; x: number; y: number };

function connectionMenu(
  c: Connection,
  groups: Group[],
  connected: boolean,
): { items: MenuItem[]; run: (id: string) => void } {
  const s = useConnections.getState();
  const items: MenuItem[] = [
    connected ? { id: "disconnect", label: "Disconnect" } : { id: "connect", label: "Connect" },
    { id: "edit", label: "Edit…" },
    { id: "rename", label: "Rename…" },
    { id: "duplicate", label: "Duplicate" },
    ...ENVIRONMENTS.filter((e) => e.id !== c.environment).map((e) => ({
      id: `env:${e.id}`,
      label: `Set environment: ${e.label}`,
    })),
    ...(c.groupId ? [{ id: "move:", label: "Move to Ungrouped" }] : []),
    ...groups
      .filter((g) => g.id !== c.groupId)
      .map((g) => ({ id: `move:${g.id}`, label: `Move to ${g.name}` })),
    { id: "move:__new__", label: "Move to new group…" },
    { id: "delete", label: "Delete…" },
  ];
  const run = (id: string) => {
    if (id === "connect") void runCommand("connection.open", c.id);
    else if (id === "disconnect") void s.requestDisconnect(c.id);
    else if (id === "edit") s.openEdit(c.id);
    else if (id === "rename") s.setModal({ kind: "rename", id: c.id });
    else if (id === "duplicate") void s.duplicate(c.id);
    else if (id === "delete") s.setModal({ kind: "delete", id: c.id });
    else if (id === "move:__new__") s.setModal({ kind: "newGroup", moveConnectionId: c.id });
    else if (id.startsWith("move:")) void s.move(c.id, id.slice(5) || null);
    else if (id.startsWith("env:")) {
      void s.setEnvironment(c.id, id.slice(4) as Connection["environment"]);
    }
  };
  return { items, run };
}

function Row({
  c,
  selected,
  connected,
  busy,
  openMenu,
}: {
  c: Connection;
  selected: boolean;
  connected: boolean;
  busy?: string;
  openMenu: (x: number, y: number) => void;
}) {
  const select = useConnections((s) => s.select);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter") void runCommand("connection.open", c.id);
    else if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      openMenu(r.left + 24, r.bottom);
    } else if (e.key === "F2") useConnections.getState().setModal({ kind: "rename", id: c.id });
    else if (e.key === "Delete") useConnections.getState().setModal({ kind: "delete", id: c.id });
  };
  return (
    <div
      role="option"
      tabIndex={0}
      aria-selected={selected}
      className={styles.row}
      data-connection-id={c.id}
      onClick={() => select(c.id)}
      onDoubleClick={() => void runCommand("connection.open", c.id)}
      onContextMenu={(e: MouseEvent) => {
        e.preventDefault();
        select(c.id);
        openMenu(e.clientX, e.clientY);
      }}
      onKeyDown={onKey}
    >
      <EnvDot env={BADGE_ENV[c.environment]} />
      <DriverBadge driver={badgeDriver(c.driver)} />
      <span className={styles.name} title={c.name}>
        {c.name}
      </span>
      {busy ? (
        <span className={styles.spin}>{busy === "connecting" ? "connecting…" : "…"}</span>
      ) : null}
      {connected ? <span className={styles.live} role="img" aria-label="Connected" /> : null}
      <button
        type="button"
        className={styles.more}
        aria-label={`Actions for ${c.name}`}
        aria-haspopup="menu"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          openMenu(r.left, r.bottom + 2);
        }}
      >
        ⋯
      </button>
    </div>
  );
}

/** The saved connections, grouped. The database explorer nests schema trees under these later. */
export function ConnectionList() {
  const { file, connected, busy, selectedId, setModal } = useConnections();
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<MenuTarget | null>(null);

  const sections = useMemo(() => {
    const byGroup = new Map<string | null, Connection[]>();
    for (const c of file.connections) {
      const key = c.groupId && file.groups.some((g) => g.id === c.groupId) ? c.groupId : null;
      byGroup.set(key, [...(byGroup.get(key) ?? []), c]);
    }
    const sorted = [...file.groups].sort(
      (a, b) => a.order - b.order || a.name.localeCompare(b.name),
    );
    return [
      ...sorted.map((g) => ({ group: g as Group | null, items: byGroup.get(g.id) ?? [] })),
      { group: null, items: byGroup.get(null) ?? [] },
    ].filter((s) => s.group || s.items.length > 0);
  }, [file]);

  let menuItems: MenuItem[] = [];
  let runMenu: (id: string) => void = () => {};
  if (menu?.kind === "connection") {
    const c = file.connections.find((x) => x.id === menu.id);
    if (c) ({ items: menuItems, run: runMenu } = connectionMenu(c, file.groups, !!connected[c.id]));
  } else if (menu?.kind === "group") {
    menuItems = [
      { id: "rename", label: "Rename group…" },
      { id: "delete", label: "Delete group" },
    ];
    runMenu = (id) =>
      setModal({ kind: id === "rename" ? "renameGroup" : "deleteGroup", id: menu.id });
  }

  return (
    <div className={styles.list} role="listbox" aria-label="Connections">
      {sections.map(({ group, items }) => {
        const key = group?.id ?? "__ungrouped__";
        const closed = collapsed[key];
        const showHead = group !== null || sections.length > 1;
        return (
          <div key={key} role="group" aria-label={group?.name ?? "Ungrouped"}>
            {showHead ? (
              <div className={styles.groupHead}>
                <button
                  type="button"
                  className={styles.groupToggle}
                  aria-expanded={!closed}
                  onClick={() => setCollapsed((s) => ({ ...s, [key]: !closed }))}
                >
                  {closed ? <ChevronRight size={10} /> : <ChevronDown size={10} />}
                  {group?.name ?? "Ungrouped"}
                </button>
                {group ? (
                  <button
                    type="button"
                    className={styles.more}
                    aria-label={`Actions for group ${group.name}`}
                    aria-haspopup="menu"
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setMenu({ kind: "group", id: group.id, x: r.left, y: r.bottom + 2 });
                    }}
                  >
                    ⋯
                  </button>
                ) : null}
              </div>
            ) : null}
            {closed
              ? null
              : items.map((c) => (
                  <Row
                    key={c.id}
                    c={c}
                    selected={selectedId === c.id}
                    connected={!!connected[c.id]}
                    busy={busy[c.id]}
                    openMenu={(x, y) => setMenu({ kind: "connection", id: c.id, x, y })}
                  />
                ))}
          </div>
        );
      })}
      <div className={styles.footer}>
        <button
          type="button"
          className={styles.link}
          onClick={() => setModal({ kind: "newGroup" })}
        >
          <Plus size={10} /> New group
        </button>
      </div>
      {menu && menuItems.length > 0 ? (
        <>
          <div className={styles.menuScrim} onMouseDown={() => setMenu(null)} aria-hidden="true" />
          <div className={styles.menuHost} style={{ left: menu.x, top: menu.y }}>
            <Menu
              aria-label="Connection actions"
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
    </div>
  );
}
