import { Button, IconButton } from "../components/Button";
import { Plus } from "../components/icons";
import { ConnectionList } from "../connections/ConnectionList";
import { useConnections } from "../connections/connectionsStore";
import { SplitPane } from "../components/SplitPane";
import { useLayout } from "../stores/layoutStore";
import { runCommand } from "./registry/commands";
import { useSlots } from "./registry/slots";
import styles from "./Sidebar.module.css";

export const SIDEBAR = { default: 272, min: 240, max: 420, key: "layout.sidebarWidth" } as const;

/** The explorer panel. Features contribute the body through the `sidebar` slot. */
export function SidebarPanel() {
  const items = useSlots((s) => s.slots.sidebar);
  const hasConnections = useConnections((s) => s.file.connections.length > 0);
  return (
    <aside className={styles.sidebar} aria-label="Explorer">
      <div className={styles.header}>
        <span>Explorer</span>
        <IconButton aria-label="New connection" onClick={() => void runCommand("connection.new")}>
          <Plus size={14} />
        </IconButton>
      </div>
      <div className={styles.body}>
        {hasConnections || items.length > 0 ? (
          <>
            {hasConnections ? <ConnectionList /> : null}
            {items.map((i) => (
              <div key={i.id}>{i.render()}</div>
            ))}
          </>
        ) : (
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
              Import
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

/** Inline resizable sidebar, or the overlay variant when the window is narrow. */
export function Sidebar() {
  const sidebarOpen = useLayout((s) => s.sidebarOpen);
  const narrow = useLayout((s) => s.narrow);
  const overlayOpen = useLayout((s) => s.overlayOpen);
  const closeOverlay = useLayout((s) => s.closeOverlay);

  if (narrow) {
    return overlayOpen ? (
      <div className={styles.overlayRoot}>
        <div className={styles.overlayScrim} onMouseDown={closeOverlay} aria-hidden="true" />
        <div className={styles.overlayPanel}>
          <SidebarPanel />
        </div>
      </div>
    ) : null;
  }
  if (!sidebarOpen) return null;
  return (
    <SplitPane
      edge="right"
      label="sidebar"
      defaultSize={SIDEBAR.default}
      min={SIDEBAR.min}
      max={SIDEBAR.max}
      persistKey={SIDEBAR.key}
    >
      <SidebarPanel />
    </SplitPane>
  );
}
