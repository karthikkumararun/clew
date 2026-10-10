import { useWorkspace } from "../stores/workspaceStore";
import styles from "./EditorArea.module.css";
import { getTabKind } from "./registry/tabKinds";
import { TabStrip } from "./TabStrip";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog";
import { Welcome } from "./Welcome";

export function EditorArea() {
  const tabs = useWorkspace((s) => s.tabs);
  const active = useWorkspace((s) => s.tabs.find((t) => t.id === s.activeTabId));
  const kind = active ? getTabKind(active.kind) : undefined;

  return (
    <main className={styles.area}>
      {tabs.length === 0 ? (
        <Welcome />
      ) : (
        <>
          <TabStrip />
          <section className={styles.content} aria-label="Editor">
            {active && kind ? (
              kind.render({ tab: active })
            ) : (
              <div className={styles.unknown}>This editor type is not available.</div>
            )}
          </section>
        </>
      )}
      <UnsavedChangesDialog />
    </main>
  );
}
