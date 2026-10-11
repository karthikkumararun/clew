import { useEffect } from "react";
import { NARROW_BREAKPOINT, useLayout } from "../stores/layoutStore";
import { EditorArea } from "./EditorArea";
import { Notices } from "./Notices";
import { ImportExportDialog } from "../connections/exchange/ImportExportDialog";
import { ConnectionModals } from "../connections/ConnectionPrompts";
import { ConnectionPromptHost } from "../connections/ConnectionPrompts";
import { ConnectionDialogHost } from "../connections/ConnectionDialog";
import { ConnectionPickerHost } from "../features/console/ConnectionPicker";
import { ConsolePromptHost } from "../features/console/prompts";
import { SafetyPromptHost } from "../features/safety/confirm";
import { SettingsDialog } from "./SettingsDialog";
import { SidePanel } from "./SidePanel";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { Toolbar } from "./Toolbar";
import styles from "./Workspace.module.css";

export function Workspace() {
  const setNarrow = useLayout((s) => s.setNarrow);

  useEffect(() => {
    const update = () => setNarrow(window.innerWidth < NARROW_BREAKPOINT);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [setNarrow]);

  return (
    <div className={styles.app}>
      <Toolbar />
      <div className={styles.body}>
        <Sidebar />
        <EditorArea />
        <SidePanel />
      </div>
      <StatusBar />
      <SettingsDialog />
      <ConnectionDialogHost />
      <ConnectionModals />
      <ConnectionPromptHost />
      <ConnectionPickerHost />
      <ConsolePromptHost />
      <SafetyPromptHost />
      <ImportExportDialog />
      <Notices />
    </div>
  );
}
