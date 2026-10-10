import { Terminal } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { registerTabKind } from "../../shell/registry/tabKinds";
import type { TabKind } from "../../shell/registry/tabKinds";
import { ConsoleView } from "./ConsoleView";
import { askChoice } from "./prompts";
import { disposeRuntime, peekRuntime } from "./runtime";
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
  confirmClose: async (tab) => {
    const runtime = peekRuntime(tab.id);
    const { txOpen, txPending } = runtime?.store.getState() ?? { txOpen: false, txPending: 0 };
    if (!runtime || !txOpen) return true;
    const answer = await askChoice({
      title: "Uncommitted transaction",
      body: (
        <p>
          This console has an open transaction with {txPending}{" "}
          {txPending === 1 ? "statement" : "statements"}. Commit it, roll it back, or keep the
          console open?
        </p>
      ),
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "rollback", label: "Roll back" },
        { id: "commit", label: "Commit", variant: "primary" },
      ],
    });
    if (answer !== "commit" && answer !== "rollback") return false;
    return runtime.endTransaction(answer === "commit");
  },
  onClose: (tab) => {
    disposeRuntime(tab.id);
    useConsoleUi.getState().forget(tab.id);
  },
};

export function registerConsoleTab(): () => void {
  return registerTabKind(consoleKind);
}
