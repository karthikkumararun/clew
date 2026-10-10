import { useEffect } from "react";
import { Workspace } from "./shell/Workspace";
import { installShortcutListener } from "./shell/registry/shortcuts";
import { registerConnectionCommands } from "./connections/commands";
import { useConnections } from "./connections/connectionsStore";
import { registerShellCommands } from "./shell/shellCommands";

export default function App() {
  useEffect(() => {
    const offKeys = installShortcutListener();
    const offCommands = registerShellCommands();
    const offConnections = registerConnectionCommands();
    void useConnections.getState().load();
    return () => {
      offKeys();
      offCommands();
      offConnections();
    };
  }, []);
  return <Workspace />;
}
