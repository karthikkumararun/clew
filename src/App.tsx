import { useEffect } from "react";
import { Workspace } from "./shell/Workspace";
import { installShortcutListener } from "./shell/registry/shortcuts";
import { registerConnectionCommands } from "./connections/commands";
import { useConnections } from "./connections/connectionsStore";
import { registerConsoleCommands } from "./features/console/commands";
import { installQuitGuard } from "./features/console/quit";
import { registerCollectionCommands } from "./features/documents/CollectionTab";
import { registerTableCommands } from "./features/table-editor/TableTab";
import { registerExplorerCommands } from "./features/explorer/commands";
import { registerShellCommands } from "./shell/shellCommands";

export default function App() {
  useEffect(() => {
    const offKeys = installShortcutListener();
    const offCommands = registerShellCommands();
    const offConnections = registerConnectionCommands();
    const offExplorer = registerExplorerCommands();
    const offConsole = registerConsoleCommands();
    const offTable = registerTableCommands();
    const offCollection = registerCollectionCommands();
    const offQuit = installQuitGuard();
    void useConnections.getState().load();
    return () => {
      offKeys();
      offCommands();
      offConnections();
      offExplorer();
      offConsole();
      offTable();
      offCollection();
      offQuit();
    };
  }, []);
  return <Workspace />;
}
