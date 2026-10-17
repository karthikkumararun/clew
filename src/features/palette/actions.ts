import { useConnections } from "../../connections/connectionsStore";
import { commandShortcutLabel, listCommands, runCommand } from "../../shell/registry/commands";
import { useExplorer } from "../explorer/explorerStore";
import { isTableLike } from "../explorer/names";
import { connOfId } from "../explorer/tree";

/** One entry of the ACTIONS section. */
export interface ActionEntry {
  id: string;
  title: string;
  shortcut?: string;
  run: () => void | Promise<void>;
}

/**
 * Commands that only make sense with an argument another feature supplies (an explorer node,
 * a table path, ...). They stay out of the list; the context entries below cover the useful ones.
 */
const NEEDS_ARGUMENT = new Set([
  "table.open",
  "table.filterByColumn",
  "collection.open",
  "keys.open",
  "graph.open",
  "script.open",
  "connection.open",
  "explorer.copyName",
  "explorer.copyQualifiedName",
  "explorer.openData",
  "explorer.openInConsole",
  "explorer.newConsoleHere",
  "explorer.generateDdl",
  "explorer.countRows",
  "explorer.filterByColumn",
  "explorer.openScript",
  "explorer.revealScript",
  "explorer.newScript",
  "console.cancel.escape",
  "palette.open",
  "palette.recent",
]);

/** Every registered command (spec: command-palette › Actions from the command registry). */
export function registryActions(): ActionEntry[] {
  return listCommands()
    .filter((c) => !NEEDS_ARGUMENT.has(c.id))
    .map((c) => ({
      id: c.id,
      title: c.title,
      shortcut: commandShortcutLabel(c.id),
      run: () => void runCommand(c.id),
    }));
}

/**
 * Entries that name the current selection: "Generate DDL for orders", "New console on
 * prod-postgres". They run the explorer commands against the selected node.
 */
export function contextActions(): ActionEntry[] {
  const { selectedId, nodes } = useExplorer.getState();
  if (!selectedId) return [];
  const { connected, file } = useConnections.getState();
  const entry = nodes[selectedId];
  const conn = file.connections.find((c) => c.id === connOfId(selectedId));
  const out: ActionEntry[] = [];
  if (conn) {
    out.push({
      id: `ctx.newConsole:${conn.id}`,
      title: `New console on ${conn.name}`,
      shortcut: commandShortcutLabel("console.new"),
      run: () => void runCommand("console.new", { connectionId: conn.id }),
    });
  }
  if (entry && conn && connected[conn.id] && isTableLike(entry.kind)) {
    const call = (id: string) => () => void runCommand(id, selectedId);
    out.push(
      { id: "ctx.ddl", title: `Generate DDL for ${entry.name}`, run: call("explorer.generateDdl") },
      { id: "ctx.count", title: `Count rows in ${entry.name}`, run: call("explorer.countRows") },
      {
        id: "ctx.console",
        title: `Open ${entry.name} in a console`,
        run: call("explorer.openInConsole"),
      },
      { id: "ctx.copy", title: `Copy name of ${entry.name}`, run: call("explorer.copyName") },
    );
  }
  return out;
}

export function allActions(): ActionEntry[] {
  return [...contextActions(), ...registryActions()];
}
