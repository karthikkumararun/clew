import { Terminal } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { registerTabKind } from "../../shell/registry/tabKinds";
import type { TabKind } from "../../shell/registry/tabKinds";
import { ConsoleView } from "./ConsoleView";
import { disposeRuntime } from "./runtime";
import { useConsoleUi } from "./ui";
import {
  CONSOLE_KIND,
  baseName,
  deserializeConsole,
  isConsoleDirty,
  serializeConsole,
} from "./state";
import type { ConsoleState } from "./state";

function connectionOf(state: ConsoleState) {
  return useConnections.getState().file.connections.find((c) => c.id === state.connectionId);
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
