import { useEffect } from "react";
import { Workspace } from "./shell/Workspace";
import { installShortcutListener } from "./shell/registry/shortcuts";
import { registerShellCommands } from "./shell/shellCommands";

export default function App() {
  useEffect(() => {
    const offKeys = installShortcutListener();
    const offCommands = registerShellCommands();
    return () => {
      offKeys();
      offCommands();
    };
  }, []);
  return <Workspace />;
}
