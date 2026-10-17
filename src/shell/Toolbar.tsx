import { IconButton } from "../components/Button";
import { ClewMark } from "../components/ClewMark";
import { PanelRight, Settings } from "../components/icons";
import { formatShortcut, isMac } from "../lib/platform";
import { useLayout } from "../stores/layoutStore";
import { runCommand } from "./registry/commands";
import { useSlots } from "./registry/slots";
import type { SlotItem } from "./registry/slots";
import styles from "./Toolbar.module.css";

function Items({ items }: { items: SlotItem[] }) {
  return (
    <>
      {items.map((i) => (
        <span key={i.id} style={{ display: "contents" }}>
          {i.render()}
        </span>
      ))}
    </>
  );
}

export function Toolbar() {
  const { toolbarLeft, toolbarCenter, toolbarRight } = useSlots((s) => s.slots);
  const sidePanel = useSlots((s) => s.sidePanel);
  const sidePanelOpen = useLayout((s) => s.sidePanelOpen);
  const toggleSidePanel = useLayout((s) => s.toggleSidePanel);
  const toggleSidebar = useLayout((s) => s.toggleSidebar);

  return (
    <header
      className={styles.toolbar}
      data-tauri-drag-region
      data-overlay={isMac()}
      data-metric="toolbar"
    >
      <div className={styles.brand} data-tauri-drag-region>
        <ClewMark size={20} />
        <span className={styles.wordmark} data-tauri-drag-region>
          <span className={styles.name} data-tauri-drag-region>
            Clew
          </span>
          <span className={styles.byline} data-tauri-drag-region>
            by ADK
          </span>
        </span>
      </div>
      <div className={styles.divider} />
      <IconButton aria-label="Toggle sidebar" onClick={toggleSidebar}>
        <PanelRight size={16} style={{ transform: "scaleX(-1)" }} />
      </IconButton>
      <div className={styles.group}>
        <Items items={toolbarLeft} />
      </div>
      <div className={styles.spacer} data-tauri-drag-region />
      {toolbarCenter.length > 0 ? (
        <div className={styles.center}>
          <Items items={toolbarCenter} />
        </div>
      ) : null}
      <div className={styles.group}>
        <Items items={toolbarRight} />
        {sidePanel?.toggle ? (
          <button
            type="button"
            className={styles.panelToggle}
            aria-label={`Toggle ${sidePanel.title}`}
            aria-pressed={sidePanelOpen}
            aria-keyshortcuts={sidePanel.toggle.shortcut}
            onClick={toggleSidePanel}
          >
            <sidePanel.icon size={14} />
            {sidePanel.toggle.label}
            {sidePanel.toggle.shortcut ? (
              <span className={styles.panelKeys}>{formatShortcut(sidePanel.toggle.shortcut)}</span>
            ) : null}
          </button>
        ) : sidePanel ? (
          <IconButton
            aria-label={`Toggle ${sidePanel.title}`}
            aria-pressed={sidePanelOpen}
            onClick={toggleSidePanel}
          >
            <sidePanel.icon size={16} />
          </IconButton>
        ) : null}
        <IconButton aria-label="Settings" onClick={() => void runCommand("settings.open")}>
          <Settings size={16} />
        </IconButton>
      </div>
    </header>
  );
}
