import { useEffect } from "react";
import { Workspace } from "./shell/Workspace";
import { installShortcutListener } from "./shell/registry/shortcuts";
import { registerConnectionCommands } from "./connections/commands";
import { useConnections } from "./connections/connectionsStore";
import { registerConsoleCommands } from "./features/console/commands";
import { installQuitGuard } from "./features/console/quit";
import { registerPalette } from "./features/palette";
import { registerSessionsFeature } from "./features/sessions";
import { registerCollectionCommands } from "./features/documents/CollectionTab";
import { registerGraphCommands } from "./features/graph/GraphTab";
import { registerKeysCommands } from "./features/key-value/KeysTab";
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
    const offKeys2 = registerKeysCommands();
    const offGraph = registerGraphCommands();
    const offQuit = installQuitGuard();
    const offSessions = registerSessionsFeature();
    const offPalette = registerPalette();
    void useConnections.getState().load();
    return () => {
      offKeys();
      offCommands();
      offConnections();
      offExplorer();
      offConsole();
      offTable();
      offCollection();
      offKeys2();
      offGraph();
      offQuit();
      offSessions();
      offPalette();
    };
  }, []);
  return <Workspace />;
}
