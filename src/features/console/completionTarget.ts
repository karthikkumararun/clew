import type { EditorView } from "@codemirror/view";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useConnections } from "../../connections/connectionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { sqlCompletion, watchSnapshots } from "./completion/extension";
import type { CompletionTarget } from "./completion/extension";
import { invalidateSnapshots, loadSnapshot } from "./completion/snapshots";
import type { ConsoleState } from "./state";

/** What the completion source should use for a console, read fresh on every request. */
export function completionTargetOf(tabId: string): CompletionTarget | null {
  const tab = useWorkspace.getState().tabs.find((t) => t.id === tabId);
  const state = tab?.state as ConsoleState | undefined;
  if (!state) return null;
  const { file, connected } = useConnections.getState();
  const connection = file.connections.find((c) => c.id === state.connectionId);
  if (!connection) return null;
  const settings = connection.settings;
  const configured = "database" in settings && settings.database ? settings.database : "";
  const database = state.database ?? configured;
  return {
    connectionId: connection.id,
    driver: connection.driver,
    database,
    // Unqualified names resolve in the chosen schema, else the usual default.
    defaultSchema:
      state.schema ?? (connection.driver === "postgres" ? "public" : database || "main"),
    connected: !!connected[connection.id],
  };
}

/**
 * The completion extension of a console plus the wiring around it: fetch the snapshot as soon
 * as the connection is up, drop it when the connection goes away, and re-offer an open popup
 * when the snapshot arrives.
 */
export function useExtensionTarget(tabId: string) {
  const extension = useMemo(
    () =>
      sqlCompletion(() => {
        const t = completionTargetOf(tabId);
        return (
          t ?? {
            connectionId: "",
            driver: "",
            database: "",
            defaultSchema: undefined,
            connected: false,
          }
        );
      }),
    [tabId],
  );
  const stop = useRef<() => void>(() => {});

  const onReady = useCallback(
    (view: EditorView) => {
      stop.current();
      const t = completionTargetOf(tabId);
      stop.current = t ? watchSnapshots(view, t.connectionId) : () => {};
    },
    [tabId],
  );

  const target = useConnections((s) => completionTargetOf(tabId) && s.connected);
  useEffect(() => {
    const t = completionTargetOf(tabId);
    if (t?.connected) void loadSnapshot(t.connectionId, t.database).catch(() => {});
  }, [tabId, target]);

  useEffect(() => () => stop.current(), []);
  return { extension, onReady };
}

/** Drop snapshots of connections that disconnect, so a reconnect starts clean. */
export function startSnapshotSync(): () => void {
  return useConnections.subscribe((state, prev) => {
    for (const id of Object.keys(prev.connected)) {
      if (!state.connected[id]) invalidateSnapshots(id);
    }
  });
}
