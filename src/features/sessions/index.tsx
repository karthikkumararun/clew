import { registerCommand } from "../../shell/registry/commands";
import { registerBottomPanel } from "../../shell/registry/slots";
import { registerStatusItem } from "../../shell/registry/statusItems";
import { setIdleNoticeHandlers } from "../../stores/sessionsStore";
import { endTransaction, rollBackAllIdle, showSession } from "./actions";
import { startSessionsBridge } from "./bridge";
import { SessionsPanel } from "./SessionsPanel";
import { toggleSessionsPanel } from "./panel";
import { SessionsStatusItem } from "./SessionsStatusItem";

export const SESSIONS_PANEL_ID = "sessions";

/**
 * The Sessions panel: the bottom dock, its shortcut and palette commands, the status bar item
 * and the glue between sessions and editors. Returns a disposer.
 */
export function registerSessionsFeature(): () => void {
  setIdleNoticeHandlers({
    rollback: (s) => void endTransaction(s.id, false),
    show: showSession,
  });
  const disposers = [
    registerBottomPanel({
      id: SESSIONS_PANEL_ID,
      title: "Sessions",
      render: () => <SessionsPanel />,
    }),
    registerCommand({
      id: "sessions.toggle",
      title: "Toggle Sessions panel",
      category: "View",
      shortcut: "Mod+Alt+S",
      run: toggleSessionsPanel,
    }),
    registerCommand({
      id: "sessions.rollbackAllIdle",
      title: "Roll back all idle transactions",
      category: "Sessions",
      run: () => rollBackAllIdle(),
    }),
    registerStatusItem({
      id: "sessions.status",
      side: "left",
      order: 5,
      render: () => <SessionsStatusItem />,
    }),
    startSessionsBridge(),
    () => setIdleNoticeHandlers(null),
  ];
  return () => disposers.forEach((d) => d());
}
