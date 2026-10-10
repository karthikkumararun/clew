import { Table as TableIcon } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { registerCommand } from "../../shell/registry/commands";
import { registerTabKind } from "../../shell/registry/tabKinds";
import type { TabKind } from "../../shell/registry/tabKinds";
import { useWorkspace } from "../../stores/workspaceStore";
import type { NodePath } from "../../lib/ipc/drivers";
import { confirmPending, registerTableShortcuts } from "./actions";
import { TableEditor } from "./TableEditor";
import { disposeTableRuntime, peekTableRuntime } from "./runtime";
import { TABLE_KIND, deserializeTable, serializeTable, tableKey, tableName } from "./state";
import type { TableTabState } from "./state";

function connectionOf(s: TableTabState) {
  return useConnections.getState().file.connections.find((c) => c.id === s.connectionId);
}

const tableKind: TabKind<TableTabState> = {
  kind: TABLE_KIND,
  icon: TableIcon,
  title: (s) => tableName(s.path),
  subtitle: (s) => connectionOf(s)?.name,
  env: (s) => {
    const c = connectionOf(s);
    return c ? BADGE_ENV[c.environment] : undefined;
  },
  serialize: serializeTable,
  deserialize: deserializeTable,
  render: ({ tab }) => <TableEditor key={tab.id} tab={tab} />,
  confirmClose: async (tab) => {
    const runtime = peekTableRuntime(tab.id);
    return runtime ? confirmPending(runtime) : true;
  },
  onClose: (tab) => disposeTableRuntime(tab.id),
};

export function registerTableTab(): () => void {
  return registerTabKind(tableKind);
}

/** Open a table (or focus its tab). Returns the tab id. */
export function openTable(
  connectionId: string,
  path: NodePath,
  extra: Partial<TableTabState> = {},
): string {
  const key = tableKey(connectionId, path);
  const store = useWorkspace.getState();
  const existing = store.tabs.find((t) => t.kind === TABLE_KIND && t.key === key);
  if (existing) {
    store.activateTab(existing.id);
    if (Object.keys(extra).length > 0)
      store.updateTabState<Partial<TableTabState>>(existing.id, extra);
    return existing.id;
  }
  const state: TableTabState = {
    connectionId,
    path,
    view: "data",
    where: "",
    orderBy: "",
    pageSize: 500,
    page: 0,
    record: false,
    ...extra,
  };
  return store.openTab({ kind: TABLE_KIND, key, state });
}

/** Commands the explorer and other screens use to reach a table. Returns a disposer. */
export function registerTableCommands(): () => void {
  const disposers = [
    registerCommand({
      id: "table.open",
      title: "Open table",
      category: "Table",
      run: (arg) => {
        const a = (arg ?? {}) as { connectionId?: string; path?: NodePath };
        if (a.connectionId && a.path) openTable(a.connectionId, a.path);
      },
    }),
    registerCommand({
      id: "table.filterByColumn",
      title: "Filter table by column",
      category: "Table",
      run: (arg) => {
        const a = (arg ?? {}) as { connectionId?: string; path?: NodePath; column?: string };
        if (a.connectionId && a.path && a.column) {
          openTable(a.connectionId, a.path, { view: "data", focusColumn: a.column });
        }
      },
    }),
  ];
  disposers.push(registerTableShortcuts());
  return () => disposers.forEach((d) => d());
}
