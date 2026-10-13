import { getTabKind } from "../../shell/registry/tabKinds";
import type { Tab } from "../../shell/registry/tabKinds";
import { useWorkspace } from "../../stores/workspaceStore";
import { baseName } from "../console/state";

const sessionIdOf = (tab: Tab) => (tab.state as { sessionId?: string } | null)?.sessionId;
const connectionIdOf = (tab: Tab) => (tab.state as { connectionId?: string } | null)?.connectionId;

/** Tabs that run on a session (a shared session has several). */
export function tabsOfSession(sessionId: string, tabs: Tab[] = useWorkspace.getState().tabs) {
  return tabs.filter((t) => sessionIdOf(t) === sessionId);
}

/** The name a tab gives its session: `console`, `console (2)`, `weekly_report.sql`, `orders (table editor)`. */
export function sessionNameOf(tab: Tab, tabs: Tab[]): string {
  const state = tab.state as { filePath?: string } | null;
  if (tab.kind === "console") {
    if (state?.filePath) return baseName(state.filePath);
    const plain = tabs.filter(
      (t) =>
        t.kind === "console" &&
        !(t.state as { filePath?: string } | null)?.filePath &&
        connectionIdOf(t) === connectionIdOf(tab),
    );
    const n = plain.findIndex((t) => t.id === tab.id);
    return n <= 0 ? "console" : `console (${n + 1})`;
  }
  const title = getTabKind(tab.kind)?.title(tab.state as never) ?? tab.key;
  return tab.kind === "table" ? `${title} (table editor)` : title;
}

/** What a tab is called in the strip, for rows that name a tab rather than its session. */
export const tabTitle = (tab: Tab): string => sessionNameOf(tab, useWorkspace.getState().tabs);

/** The session name of a tab by id (`console`, a file name), for dialogs. */
export function tabSessionName(tabId: string): string {
  const tabs = useWorkspace.getState().tabs;
  const tab = tabs.find((t) => t.id === tabId);
  return tab ? sessionNameOf(tab, tabs) : "console";
}
