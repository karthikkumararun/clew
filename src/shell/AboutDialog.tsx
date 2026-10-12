import { useEffect, useState } from "react";
import { Button } from "../components/Button";
import { ClewMark } from "../components/ClewMark";
import { Dialog } from "../components/Dialog";
import { connectionStateOf } from "../connections/ConnectionChip";
import { invoke } from "../lib/ipc";
import { APP_VERSION } from "../lib/appInfo";
import { useWorkspace } from "../stores/workspaceStore";
import { useAbout } from "./aboutStore";
import styles from "./AboutDialog.module.css";

interface AboutInfo {
  version: string;
  commit: string;
}

/** The connection of the active tab, which the diagnostics report describes. */
function activeConnectionId(): string | undefined {
  const { tabs, activeTabId } = useWorkspace.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab ? connectionStateOf(tab.state)?.connectionId : undefined;
}

export function AboutDialog() {
  const { open, hide } = useAbout();
  const [info, setInfo] = useState<AboutInfo>({ version: APP_VERSION, commit: "" });
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (!open) return;
    setState("idle");
    invoke<AboutInfo>("about_info")
      .then(setInfo)
      .catch(() => {});
  }, [open]);

  if (!open) return null;

  // The clipboard API needs no plugin and works from a click in the WebView.
  const copy = async () => {
    try {
      const report = await invoke<string>("diagnostics_bundle", {
        connectionId: activeConnectionId() ?? null,
      });
      await navigator.clipboard.writeText(report);
      setState("copied");
    } catch {
      setState("failed");
    }
  };

  return (
    <Dialog title="About Clew" onClose={hide} maxWidth={420}>
      <div className={styles.body}>
        <ClewMark size={56} />
        <h2 className={styles.name}>Clew</h2>
        <span className={styles.byline}>by ADK</span>
        <p className={styles.meta}>
          Version {info.version}
          {info.commit ? ` (${info.commit})` : ""}
        </p>
        <div className={styles.actions}>
          <Button variant="default" onClick={() => void copy()}>
            Copy diagnostics
          </Button>
          {state === "copied" ? (
            <span role="status" className={styles.status}>
              Copied
            </span>
          ) : null}
          {state === "failed" ? (
            <span role="alert" className={styles.error}>
              Couldn&apos;t copy diagnostics
            </span>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}

/** The version in the status bar: opens the dialog. */
export function AboutLink() {
  return (
    <button
      type="button"
      className={styles.link}
      title="About Clew"
      onClick={() => useAbout.getState().show()}
    >
      Clew v{APP_VERSION}
    </button>
  );
}
