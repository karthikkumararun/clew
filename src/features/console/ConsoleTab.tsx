import { useMemo } from "react";
import { useSettings } from "../../stores/settingsStore";
import { useExtensionTarget } from "./completionTarget";
import { Editor } from "./editor/Editor";
import { useConsoleUi } from "./ui";
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
  const fontSize = useSettings((s) => s.settings.editorFontSize);
  const completion = useExtensionTarget(tab.id);
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
      <div className={styles.editorPane}>
        <Editor
          tabId={tab.id}
          driver={connection.driver}
          value={tab.state.text}
          fontSize={fontSize}
          onChange={(text) =>
            useWorkspace.getState().updateTabState<Partial<ConsoleState>>(tab.id, { text })
          }
          onCursor={(line, col) => useConsoleUi.getState().setCursor(tab.id, line, col)}
          extensions={completion.extension}
          onReady={completion.onReady}
          onRunStatement={() => {}}
        />
      </div>
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
  onClose: (tab) => {
    disposeRuntime(tab.id);
    useConsoleUi.getState().forget(tab.id);
  },
};

export function registerConsoleTab(): () => void {
  return registerTabKind(consoleKind);
}
