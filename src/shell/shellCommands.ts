import { registerCommand } from "./registry/commands";
import { registerStatusItem } from "./registry/statusItems";
import { registerTabStatusItems } from "./tabStatus";
import { useLayout } from "../stores/layoutStore";
import { useWorkspace } from "../stores/workspaceStore";
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
    registerCommand({
      id: "tab.close",
      title: "Close tab",
      category: "Tabs",
      shortcut: "Mod+W",
      run: () => {
        const { activeTabId, requestClose } = useWorkspace.getState();
        if (activeTabId) requestClose(activeTabId);
      },
    }),
    registerCommand({
      id: "tab.next",
      title: "Next tab",
      category: "Tabs",
      shortcut: "Mod+Shift+]",
      run: () => useWorkspace.getState().activateRelative(1),
    }),
    registerCommand({
      id: "tab.previous",
      title: "Previous tab",
      category: "Tabs",
      shortcut: "Mod+Shift+[",
      run: () => useWorkspace.getState().activateRelative(-1),
    }),
    registerTabStatusItems(),
    registerStatusItem({
      id: "app.version",
      side: "right",
      order: 1000,
      render: () => `Clew v${APP_VERSION}`,
    }),
  ];
  return () => disposers.forEach((d) => d());
}
