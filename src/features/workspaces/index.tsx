import { registerCommand } from "../../shell/registry/commands";
import { registerSlotItem } from "../../shell/registry/slots";
import { connectionInContext } from "../console/context";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { openConnectionWorkspace, useWorkspaces } from "./store";

/** The workspace switcher, its commands and the explorer's "Open workspace". Returns a disposer. */
export function registerWorkspaces(): () => void {
  const disposers = [
    registerSlotItem("toolbarLeft", {
      id: "workspaces.switcher",
      order: 10,
      render: () => <WorkspaceSwitcher />,
    }),
    registerCommand({
      id: "workspace.switch",
      title: "Switch workspace",
      category: "Workspaces",
      // Cmd+Shift+W is macOS's "close window" in most apps, so the chord is Mod+Alt+W.
      shortcut: "Mod+Alt+W",
      run: () => useWorkspaces.getState().setMenuOpen(true),
    }),
    registerCommand({
      id: "workspace.new",
      title: "New workspace…",
      category: "Workspaces",
      run: () => useWorkspaces.getState().setNewOpen(true),
    }),
    registerCommand({
      id: "workspace.saveAs",
      title: "Save workspace as…",
      category: "Workspaces",
      run: () => useWorkspaces.getState().setSaveAsOpen(true),
    }),
    registerCommand({
      id: "workspace.manage",
      title: "Manage workspaces…",
      category: "Workspaces",
      run: () => useWorkspaces.getState().setManageOpen(true),
    }),
    registerCommand({
      id: "workspace.open",
      title: "Open workspace of this connection",
      category: "Workspaces",
      // The explorer passes the connection id; elsewhere the connection in context is used.
      run: async (arg) => {
        const id = typeof arg === "string" ? arg : connectionInContext();
        if (id) await openConnectionWorkspace(id);
      },
    }),
  ];
  return () => disposers.forEach((d) => d());
}
