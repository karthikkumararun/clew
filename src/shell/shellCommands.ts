import { registerCommand } from "./registry/commands";
import { registerStatusItem } from "./registry/statusItems";
import { useLayout } from "../stores/layoutStore";
import { APP_VERSION } from "../lib/appInfo";

/** Commands and status items owned by the shell itself. Returns a disposer. */
export function registerShellCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "view.toggleSidebar",
      title: "Toggle sidebar",
      category: "View",
      shortcut: "Mod+B",
      run: () => useLayout.getState().toggleSidebar(),
    }),
    registerStatusItem({
      id: "app.version",
      side: "right",
      order: 1000,
      render: () => `Clew v${APP_VERSION}`,
    }),
  ];
  return () => disposers.forEach((d) => d());
}
