import { SplitPane } from "../components/SplitPane";
import { ExplorerPanel } from "../features/explorer/ExplorerPanel";
import { useLayout } from "../stores/layoutStore";
import { useSlots } from "./registry/slots";
import styles from "./Sidebar.module.css";

export const SIDEBAR = { default: 272, min: 240, max: 420, key: "layout.sidebarWidth" } as const;

/** The explorer panel. Features can still contribute extra content through the `sidebar` slot. */
export function SidebarPanel() {
  const items = useSlots((s) => s.slots.sidebar);
  return (
    <ExplorerPanel
      extra={items.length > 0 ? items.map((i) => <div key={i.id}>{i.render()}</div>) : null}
    />
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
