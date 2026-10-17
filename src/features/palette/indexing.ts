import { useConnections } from "../../connections/connectionsStore";
import { invalidateSnapshots, loadSnapshot } from "../console/completion/snapshots";

/** The database whose snapshot represents a connection: the configured one, else its default. */
function defaultDatabase(connectionId: string): string {
  const settings = useConnections
    .getState()
    .file.connections.find((c) => c.id === connectionId)?.settings;
  return settings && "database" in settings && settings.database ? String(settings.database) : "";
}

/** Fetching a snapshot is what indexes it (Rust folds it into the palette index). */
export async function indexConnection(connectionId: string): Promise<void> {
  try {
    await loadSnapshot(connectionId, defaultDatabase(connectionId));
  } catch {
    /* the connection may have dropped; its last index stays searchable */
  }
}

/**
 * Index every connection as it connects, so objects are searchable without opening a console
 * (spec: command-palette › Object index). Returns a disposer.
 */
export function startIndexing(): () => void {
  for (const id of Object.keys(useConnections.getState().connected)) void indexConnection(id);
  return useConnections.subscribe((state, prev) => {
    for (const id of Object.keys(state.connected)) {
      if (!prev.connected[id]) void indexConnection(id);
    }
  });
}

/** Refresh the index of every connected connection now (the "Refresh object index" action). */
export async function refreshIndex(): Promise<void> {
  const ids = Object.keys(useConnections.getState().connected);
  for (const id of ids) invalidateSnapshots(id);
  await Promise.all(ids.map(indexConnection));
}
