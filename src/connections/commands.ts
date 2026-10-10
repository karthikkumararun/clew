import { registerCommand } from "../shell/registry/commands";
import { useConnections } from "./connectionsStore";

/** Commands owned by connection management. Returns a disposer. */
export function registerConnectionCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "connection.new",
      title: "New connection",
      category: "Connection",
      shortcut: "Mod+N",
      run: () => useConnections.getState().openNew(),
    }),
  ];
  return () => disposers.forEach((d) => d());
}
