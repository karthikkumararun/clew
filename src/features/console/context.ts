import { useConnections } from "../../connections/connectionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { useExplorer } from "../explorer/explorerStore";
import { connOfId } from "../explorer/tree";

/** The connection a new console should use: the explorer's selection, else the active tab's. */
export function connectionInContext(): string | null {
  const known = new Set(useConnections.getState().file.connections.map((c) => c.id));
  const selected = useExplorer.getState().selectedId;
  if (selected && known.has(connOfId(selected)) && !selected.startsWith("group:")) {
    return connOfId(selected);
  }
  const { tabs, activeTabId } = useWorkspace.getState();
  const active = tabs.find((t) => t.id === activeTabId);
  const bound = (active?.state as { connectionId?: string } | undefined)?.connectionId;
  return bound && known.has(bound) ? bound : null;
}
