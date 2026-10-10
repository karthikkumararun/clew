import { useMemo } from "react";
import { Terminal } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { registerTabKind } from "../../shell/registry/tabKinds";
import type { Tab, TabKind } from "../../shell/registry/tabKinds";
import { useWorkspace } from "../../stores/workspaceStore";
import { disposeRuntime, getRuntime } from "./runtime";
import {
  CONSOLE_KIND,
  baseName,
  deserializeConsole,
  isConsoleDirty,
  serializeConsole,
} from "./state";
import type { ConsoleState } from "./state";
import styles from "./Console.module.css";

function connectionOf(state: ConsoleState) {
  return useConnections.getState().file.connections.find((c) => c.id === state.connectionId);
}

function ConsoleView({ tab }: { tab: Tab<ConsoleState> }) {
  const connection = useConnections((s) =>
    s.file.connections.find((c) => c.id === tab.state.connectionId),
  );
  // The runtime (session, running query) outlives this view.
  useMemo(() => getRuntime(tab.id, tab.state.connectionId), [tab.id, tab.state.connectionId]);
  if (!connection) {
    return (
      <div className={styles.missing} role="alert">
        The connection for this console no longer exists.
      </div>
    );
  }
  return (
    <div className={styles.console} data-shortcut-scope="editor">
      <textarea
        className={styles.plainEditor}
        aria-label="SQL editor"
        spellCheck={false}
        value={tab.state.text}
        onChange={(e) =>
          useWorkspace.getState().updateTabState<Partial<ConsoleState>>(tab.id, {
            text: e.target.value,
          })
        }
      />
    </div>
  );
}

const consoleKind: TabKind<ConsoleState> = {
  kind: CONSOLE_KIND,
  icon: Terminal,
  title: (s) => (s.filePath ? baseName(s.filePath) : "console"),
  subtitle: (s) => (s.filePath ? undefined : connectionOf(s)?.name),
  env: (s) => {
    const c = connectionOf(s);
    return c ? BADGE_ENV[c.environment] : undefined;
  },
  isDirty: isConsoleDirty,
  serialize: serializeConsole,
  deserialize: deserializeConsole,
  render: ({ tab }) => <ConsoleView key={tab.id} tab={tab} />,
  onClose: (tab) => disposeRuntime(tab.id),
};

export function registerConsoleTab(): () => void {
  return registerTabKind(consoleKind);
}
