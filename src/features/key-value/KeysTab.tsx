import { Key } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { registerCommand } from "../../shell/registry/commands";
import { registerTabKind } from "../../shell/registry/tabKinds";
import type { TabKind } from "../../shell/registry/tabKinds";
import { useWorkspace } from "../../stores/workspaceStore";
import { KeyBrowser } from "./KeyBrowser";
import { disposeKeysRuntime } from "./runtime";
import { KEYS_KIND, deserializeKeys, keysKey, serializeKeys } from "./state";
import type { KeysTabState } from "./state";

function connectionOf(s: KeysTabState) {
  return useConnections.getState().file.connections.find((c) => c.id === s.connectionId);
}

const keysKind: TabKind<KeysTabState> = {
  kind: KEYS_KIND,
  icon: Key,
  title: (s) => `db${s.db}`,
  subtitle: (s) => connectionOf(s)?.name,
  env: (s) => {
    const c = connectionOf(s);
    return c ? BADGE_ENV[c.environment] : undefined;
  },
  serialize: serializeKeys,
  deserialize: deserializeKeys,
  render: ({ tab }) => <KeyBrowser key={tab.id} tab={tab} />,
  onClose: (tab) => disposeKeysRuntime(tab.id),
};

export function registerKeysTab(): () => void {
  return registerTabKind(keysKind);
}

/** Open the key browser of a Redis database (or focus its tab). Returns the tab id. */
export function openKeys(connectionId: string, db: number, extra: Partial<KeysTabState> = {}) {
  const key = keysKey(connectionId, db);
  const store = useWorkspace.getState();
  const existing = store.tabs.find((t) => t.kind === KEYS_KIND && t.key === key);
  if (existing) {
    store.activateTab(existing.id);
    if (Object.keys(extra).length > 0) {
      store.updateTabState<Partial<KeysTabState>>(existing.id, extra);
    }
    return existing.id;
  }
  const state: KeysTabState = { connectionId, db, pattern: "", selected: null, ...extra };
  return store.openTab({ kind: KEYS_KIND, key, state });
}

/** Commands the explorer uses to reach the key browser. Returns a disposer. */
export function registerKeysCommands(): () => void {
  const off = registerCommand({
    id: "keys.open",
    title: "Browse keys",
    category: "Redis",
    run: (arg) => {
      const a = (arg ?? {}) as { connectionId?: string; db?: number; pattern?: string };
      if (a.connectionId) {
        openKeys(
          a.connectionId,
          a.db ?? 0,
          a.pattern === undefined ? {} : { pattern: a.pattern, selected: null },
        );
      }
    },
  });
  return off;
}
