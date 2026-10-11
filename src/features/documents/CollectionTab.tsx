import { Database } from "../../components/icons";
import { useConnections } from "../../connections/connectionsStore";
import { BADGE_ENV } from "../../connections/display";
import { registerCommand } from "../../shell/registry/commands";
import { registerShortcut } from "../../shell/registry/shortcuts";
import { registerTabKind } from "../../shell/registry/tabKinds";
import type { TabKind } from "../../shell/registry/tabKinds";
import { useWorkspace } from "../../stores/workspaceStore";
import { collectionActions } from "./actions";
import { CollectionBrowser, confirmDiscard } from "./CollectionBrowser";
import { disposeCollectionRuntime, peekCollectionRuntime } from "./runtime";
import {
  COLLECTION_KIND,
  DEFAULT_PIPELINE,
  DEFAULT_SORT,
  collectionKey,
  deserializeCollection,
  serializeCollection,
} from "./state";
import type { CollectionTabState } from "./state";

function connectionOf(s: CollectionTabState) {
  return useConnections.getState().file.connections.find((c) => c.id === s.connectionId);
}

const collectionKind: TabKind<CollectionTabState> = {
  kind: COLLECTION_KIND,
  icon: Database,
  title: (s) => s.collection,
  subtitle: (s) => connectionOf(s)?.name,
  env: (s) => {
    const c = connectionOf(s);
    return c ? BADGE_ENV[c.environment] : undefined;
  },
  serialize: serializeCollection,
  deserialize: deserializeCollection,
  render: ({ tab }) => <CollectionBrowser key={tab.id} tab={tab} />,
  confirmClose: async (tab) => {
    const runtime = peekCollectionRuntime(tab.id);
    return runtime && runtime.pendingCount > 0 ? confirmDiscard(runtime) : true;
  },
  onClose: (tab) => disposeCollectionRuntime(tab.id),
};

export function registerCollectionTab(): () => void {
  return registerTabKind(collectionKind);
}

/** Open a collection (or focus its tab). Returns the tab id. */
export function openCollection(
  connectionId: string,
  database: string,
  collection: string,
  extra: Partial<CollectionTabState> = {},
): string {
  const key = collectionKey(connectionId, database, collection);
  const store = useWorkspace.getState();
  const existing = store.tabs.find((t) => t.kind === COLLECTION_KIND && t.key === key);
  if (existing) {
    store.activateTab(existing.id);
    if (Object.keys(extra).length > 0) {
      store.updateTabState<Partial<CollectionTabState>>(existing.id, extra);
    }
    return existing.id;
  }
  const state: CollectionTabState = {
    connectionId,
    database,
    collection,
    filter: "",
    project: "",
    sort: DEFAULT_SORT,
    limit: 0,
    pipeline: DEFAULT_PIPELINE,
    pane: "documents",
    docView: "tree",
    ...extra,
  };
  return store.openTab({ kind: COLLECTION_KIND, key, state });
}

function activeCollectionTab() {
  const { activeTabId, tabs } = useWorkspace.getState();
  const tab = tabs.find((t) => t.id === activeTabId);
  return tab && tab.kind === COLLECTION_KIND ? tab : undefined;
}

/** Commands and shortcuts of the document browser. Returns a disposer. */
export function registerCollectionCommands(): () => void {
  const offs = [
    registerCommand({
      id: "collection.open",
      title: "Open collection",
      category: "Collection",
      run: (arg) => {
        const a = (arg ?? {}) as {
          connectionId?: string;
          database?: string;
          collection?: string;
          filter?: string;
        };
        if (a.connectionId && a.database && a.collection) {
          openCollection(
            a.connectionId,
            a.database,
            a.collection,
            a.filter === undefined ? {} : { pane: "documents", filter: a.filter },
          );
        }
      },
    }),
    registerShortcut({
      id: "collection.find",
      keys: "Mod+Enter",
      scope: "documents",
      when: () => activeCollectionTab() !== undefined,
      run: () => {
        const tab = activeCollectionTab();
        if (tab) collectionActions(tab.id)?.find();
      },
    }),
    registerShortcut({
      id: "collection.save",
      keys: "Mod+S",
      scope: "documents",
      when: () => activeCollectionTab() !== undefined,
      run: () => {
        const tab = activeCollectionTab();
        if (tab) collectionActions(tab.id)?.save();
      },
    }),
  ];
  return () => offs.forEach((o) => o());
}
