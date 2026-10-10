import { connOfId } from "../explorer/tree";
import { useExplorer } from "../explorer/explorerStore";
import { useConnections } from "../../connections/connectionsStore";
import { registerCommand } from "../../shell/registry/commands";
import { useWorkspace } from "../../stores/workspaceStore";
import { pickConnection } from "./ConnectionPicker";
import { CONSOLE_KIND, newConsoleKey } from "./state";
import type { ConsoleState } from "./state";

/** Arguments of `console.new`. */
export interface NewConsoleArgs {
  connectionId?: string;
  database?: string;
  schema?: string;
  /** Initial text; not run. */
  sql?: string;
}

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

/** Open a console tab (always a new one). Returns its tab id, or null if nothing was chosen. */
export async function openConsole(args: NewConsoleArgs = {}): Promise<string | null> {
  const connectionId = args.connectionId ?? connectionInContext() ?? (await pickConnection());
  if (!connectionId) return null;
  const state: ConsoleState = {
    connectionId,
    database: args.database,
    schema: args.schema,
    text: args.sql ?? "",
    txMode: "auto",
  };
  return useWorkspace.getState().openTab({ kind: CONSOLE_KIND, key: newConsoleKey(), state });
}

/** Commands owned by the SQL console. Returns a disposer. */
export function registerConsoleCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "console.new",
      title: "New console",
      category: "Console",
      shortcut: "Mod+T",
      run: async (arg) => {
        const a = (arg && typeof arg === "object" ? arg : {}) as NewConsoleArgs;
        await openConsole(a);
      },
    }),
  ];
  return () => disposers.forEach((d) => d());
}
