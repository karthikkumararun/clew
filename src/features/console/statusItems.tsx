import { useConnections } from "../../connections/connectionsStore";
import { registerStatusItem } from "../../shell/registry/statusItems";
import { useStore } from "zustand";
import { useWorkspace } from "../../stores/workspaceStore";
import { dialectLabel } from "./editor/dialects";
import { getRuntime } from "./runtime";
import { CONSOLE_KIND } from "./state";
import type { ConsoleState } from "./state";
import { useConsoleUi } from "./ui";

/** The active tab, when it is a console. */
function useActiveConsole() {
  return useWorkspace((s) => {
    const t = s.tabs.find((x) => x.id === s.activeTabId);
    return t && t.kind === CONSOLE_KIND ? t : undefined;
  });
}

function Cursor() {
  const tab = useActiveConsole();
  const pos = useConsoleUi((s) => (tab ? s.cursor[tab.id] : undefined));
  if (!tab) return null;
  const { line, col } = pos ?? { line: 1, col: 1 };
  return <>{`Ln ${line}, Col ${col}`}</>;
}

function Dialect() {
  const tab = useActiveConsole();
  const driver = useConnections(
    (s) =>
      s.file.connections.find(
        (c) => c.id === (tab?.state as ConsoleState | undefined)?.connectionId,
      )?.driver,
  );
  return tab ? <>{dialectLabel(driver ?? "")}</> : null;
}

function Tx() {
  const tab = useActiveConsole();
  if (!tab) return null;
  return (
    <TxState
      tabId={tab.id}
      connectionId={(tab.state as ConsoleState).connectionId}
      mode={(tab.state as ConsoleState).txMode}
    />
  );
}

function TxState({
  tabId,
  connectionId,
  mode,
}: {
  tabId: string;
  connectionId: string;
  mode: "auto" | "manual";
}) {
  const runtime = getRuntime(tabId, connectionId);
  const open = useStore(runtime.store, (s) => s.txOpen);
  const pending = useStore(runtime.store, (s) => s.txPending);
  if (mode === "auto") return <>Auto-commit</>;
  return <>{open ? `Transaction · ${pending} pending` : "Manual · no transaction"}</>;
}

/** Status-bar items for the active console: cursor, encoding, dialect and transaction state. */
export function registerConsoleStatusItems(): () => void {
  const disposers = [
    registerStatusItem({
      id: "console.cursor",
      side: "right",
      order: 20,
      render: () => <Cursor />,
    }),
    registerStatusItem({
      id: "console.encoding",
      side: "right",
      order: 21,
      render: () => <Encoding />,
    }),
    registerStatusItem({
      id: "console.dialect",
      side: "right",
      order: 22,
      render: () => <Dialect />,
    }),
    registerStatusItem({ id: "console.tx", side: "right", order: 23, render: () => <Tx /> }),
  ];
  return () => disposers.forEach((d) => d());
}

function Encoding() {
  return useActiveConsole() ? <>UTF-8</> : null;
}
