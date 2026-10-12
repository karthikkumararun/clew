import { IconButton } from "../components/Button";
import { Close } from "../components/icons";
import { SplitPane } from "../components/SplitPane";
import { useLayout } from "../stores/layoutStore";
import { useSlots } from "./registry/slots";
import styles from "./SidePanel.module.css";

export const SIDE_PANEL = {
  default: 380,
  min: 320,
  max: 560,
  key: "layout.sidePanelWidth",
} as const;

export function SidePanel() {
  const def = useSlots((s) => s.sidePanel);
  const open = useLayout((s) => s.sidePanelOpen);
  const close = useLayout((s) => s.closeSidePanel);
  if (!def || !open) return null;
  return (
    <SplitPane
      edge="left"
      label={def.title}
      metric="side-panel"
      defaultSize={SIDE_PANEL.default}
      min={SIDE_PANEL.min}
      max={SIDE_PANEL.max}
      persistKey={SIDE_PANEL.key}
    >
      <aside className={styles.panel} aria-label={def.title}>
        <div className={styles.header}>
          <span>{def.title}</span>
          <IconButton aria-label={`Close ${def.title}`} onClick={close}>
            <Close size={12} />
          </IconButton>
        </div>
        <div className={styles.body}>{def.render()}</div>
      </aside>
    </SplitPane>
  );
}
