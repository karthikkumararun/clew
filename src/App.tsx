import { useEffect } from "react";
import { Workspace } from "./shell/Workspace";
import { installShortcutListener } from "./shell/registry/shortcuts";
import { registerConnectionCommands } from "./connections/commands";
import { useConnections } from "./connections/connectionsStore";
import { registerExplorerCommands } from "./features/explorer/commands";
import { registerShellCommands } from "./shell/shellCommands";

export default function App() {
  useEffect(() => {
    const offKeys = installShortcutListener();
    const offCommands = registerShellCommands();
    const offConnections = registerConnectionCommands();
    const offExplorer = registerExplorerCommands();
    void useConnections.getState().load();
    return () => {
      offKeys();
      offCommands();
      offConnections();
      offExplorer();
    };
  }, []);
  return <Workspace />;
}
