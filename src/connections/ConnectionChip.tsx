import { useRef, useState } from "react";
import { DriverBadge, EnvDot } from "../components/Badge";
import { Menu } from "../components/Menu";
import type { MenuItem } from "../components/Menu";
import { ChevronDown } from "../components/icons";
import { introspectChildren } from "../lib/ipc/drivers";
import { useNotices } from "../stores/noticesStore";
import { useWorkspace } from "../stores/workspaceStore";
import { sessionSwitchNamespace } from "./api";
import { useConnections } from "./connectionsStore";
import { BADGE_ENV, badgeDriver } from "./display";
import styles from "./ConnectionList.module.css";

/** What a tab bound to a connection keeps in its state (console and table editors). */
export interface ConnectionTabState {
  connectionId: string;
  sessionId?: string;
  database?: string;
  schema?: string;
}

export function connectionStateOf(state: unknown): ConnectionTabState | null {
  const s = state as Partial<ConnectionTabState> | null;
  return s && typeof s.connectionId === "string" ? (s as ConnectionTabState) : null;
}

/** The statement-free part of switching: pick the menu entries for a database / schema list. */
export function namespaceMenu(
  databases: string[],
  schemas: string[],
  current: { database?: string; schema?: string },
): MenuItem[] {
  const mark = (on: boolean) => (on ? "✓ " : "");
  return [
    ...databases.map((d) => ({
      id: `db:${d}`,
      label: `${mark(d === current.database)}Database ${d}`,
    })),
    ...schemas.map((s) => ({
      id: `schema:${s}`,
      label: `${mark(s === current.schema)}Schema ${s}`,
    })),
  ];
}

function useActiveConnectionTab() {
  return useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
}

export function ConnectionChip() {
  const tab = useActiveConnectionTab();
  const file = useConnections((s) => s.file);
  const [items, setItems] = useState<MenuItem[] | null>(null);
  const chipRef = useRef<HTMLButtonElement>(null);
  // Closing the menu hands focus back to the chip that opened it.
  const closeMenu = () => {
    setItems(null);
    chipRef.current?.focus();
  };
  const state = tab ? connectionStateOf(tab.state) : null;
  const connection = state ? file.connections.find((c) => c.id === state.connectionId) : undefined;
  if (!tab || !state || !connection) return null;

  const scope = [state.database, state.schema].filter(Boolean).join(" · ");

  const openMenu = async () => {
    try {
      const roots = await introspectChildren(connection.id, []);
      const databases = roots.filter((n) => n.kind === "database").map((n) => n.name);
      const db = state.database ?? databases[0];
      const kids = db
        ? await introspectChildren(connection.id, [{ kind: "database", name: db }])
        : [];
      const schemas = kids.filter((n) => n.kind === "schema").map((n) => n.name);
      setItems(namespaceMenu(databases, schemas, state));
    } catch (e) {
      useNotices.getState().push(`Couldn't list databases: ${(e as { message?: string }).message}`);
    }
  };

  const pick = async (id: string) => {
    closeMenu();
    const [kind, ...rest] = id.split(":");
    const name = rest.join(":");
    try {
      // Without a session yet the choice is kept on the tab and applied when one opens.
      if (state.sessionId) {
        await sessionSwitchNamespace(
          state.sessionId,
          kind === "db" ? { database: name } : { schema: name },
        );
      }
      useWorkspace
        .getState()
        .updateTabState<Partial<ConnectionTabState>>(
          tab.id,
          kind === "db" ? { database: name } : { schema: name },
        );
    } catch (e) {
      useNotices.getState().push(`Couldn't switch: ${(e as { message?: string }).message}`);
    }
  };

  return (
    <span className={styles.chipWrap}>
      <button
        ref={chipRef}
        type="button"
        className={styles.chip}
        aria-haspopup="menu"
        aria-expanded={items !== null}
        onClick={() => (items ? closeMenu() : void openMenu())}
      >
        {/* the name comes from the content: decorative badges are hidden from it, and the word
            "Connection" is read but not drawn */}
        <span className="sr-only">Connection </span>
        <span aria-hidden="true" className={styles.chipBadges}>
          <EnvDot env={BADGE_ENV[connection.environment]} />
          <DriverBadge driver={badgeDriver(connection.driver)} />
        </span>
        <span className={styles.chipName}>{connection.name}</span>
        {scope ? (
          <>
            {" "}
            <span className={styles.chipScope}>{scope}</span>
          </>
        ) : null}
        <ChevronDown size={10} />
      </button>
      {items ? (
        <>
          <div className={styles.menuScrim} onMouseDown={() => setItems(null)} aria-hidden="true" />
          <div className={styles.chipMenu}>
            <Menu
              aria-label="Switch database or schema"
              items={
                items.length
                  ? items
                  : [{ id: "none", label: "Nothing to switch to", disabled: true }]
              }
              onClose={closeMenu}
              onSelect={(id) => void pick(id)}
            />
          </div>
        </>
      ) : null}
    </span>
  );
}
