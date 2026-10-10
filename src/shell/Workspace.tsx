import { useEffect } from "react";
import { NARROW_BREAKPOINT, useLayout } from "../stores/layoutStore";
import { EditorArea } from "./EditorArea";
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
    </div>
  );
}
