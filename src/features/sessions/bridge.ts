import { peekTableRuntime } from "../table-editor/runtime";
import { allRuntimes } from "../console/runtime";
import { useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";
import { sessionSetMeta } from "./api";
import { sessionNameOf } from "./tabs";
import type { Tab } from "../../shell/registry/tabKinds";

/**
 * Keeps this window's editors and the backend's session list in step:
 *  - a tab that has a session names it (`session_set_meta`) when the session opens and when the
 *    tab's name changes (a file is saved under another name, a console is renumbered);
 *  - a session the panel or the backend ended (Close session, Close all, Deactivate) is dropped
 *    by its console / table tab, which opens another one on next use;
 *  - a transaction the panel committed or rolled back clears the console's own transaction flag.
 * Returns a disposer.
 */
export function startSessionsBridge(): () => void {
  const sent = new Map<string, string>();

  const pushNames = (tabs: Tab[]) => {
    const seen = new Set<string>();
    for (const tab of tabs) {
      const sessionId = (tab.state as { sessionId?: string } | null)?.sessionId;
      // The first tab bound to a session names it; tabs attached later only share it.
      if (!sessionId || seen.has(sessionId)) continue;
      seen.add(sessionId);
      const name = sessionNameOf(tab, tabs);
      const key = `${tab.id}|${name}`;
      if (sent.get(sessionId) === key) continue;
      sent.set(sessionId, key);
      void sessionSetMeta({ sessionId, name, tabId: tab.id }).catch(() => sent.delete(sessionId));
    }
    for (const id of [...sent.keys()]) if (!seen.has(id)) sent.delete(id);
  };

  const offTabs = useWorkspace.subscribe((s, prev) => {
    if (s.tabs !== prev.tabs) pushNames(s.tabs);
  });
  pushNames(useWorkspace.getState().tabs);

  const offSessions = useSessions.subscribe((s, prev) => {
    if (s.sessions === prev.sessions) return;
    for (const runtime of allRuntimes()) {
      const id = runtime.sessionId;
      if (!id) continue;
      const meta = s.sessions[id];
      if (!meta) {
        if (prev.sessions[id]) runtime.sessionLost();
        continue;
      }
      const state = runtime.store.getState();
      if (state.txOpen && !state.busy && meta.state === "idle") {
        runtime.store.setState({ txOpen: false, txPending: 0 });
      }
    }
    for (const tab of useWorkspace.getState().tabs) {
      const id = (tab.state as { sessionId?: string } | null)?.sessionId;
      if (id && !s.sessions[id] && prev.sessions[id]) peekTableRuntime(tab.id)?.sessionLost();
    }
  });

  return () => {
    offTabs();
    offSessions();
  };
}
