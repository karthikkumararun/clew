import { useLayout } from "../../stores/layoutStore";
import { useSessions } from "../../stores/sessionsStore";
import { useWorkspace } from "../../stores/workspaceStore";

/** Open the panel with the active tab's session selected (spec: Sessions panel › Open the panel). */
export function openSessionsPanel(): void {
  const tab = useWorkspace
    .getState()
    .tabs.find((t) => t.id === useWorkspace.getState().activeTabId);
  const sessionId = (tab?.state as { sessionId?: string } | null)?.sessionId;
  const { sessions, select } = useSessions.getState();
  if (sessionId && sessions[sessionId]) select({ kind: "session", id: sessionId });
  useLayout.getState().openBottomPanel();
}

export function toggleSessionsPanel(): void {
  if (useLayout.getState().bottomPanelOpen) useLayout.getState().closeBottomPanel();
  else openSessionsPanel();
}
