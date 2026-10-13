import { useRef } from "react";
import { AnchoredMenu } from "../../components/AnchoredMenu";
import { Menu } from "../../components/Menu";
import { useSessions } from "../../stores/sessionsStore";
import { attachTab } from "./actions";
import { tabsOfSession, tabTitle } from "./tabs";
import type { SessionMeta } from "./types";

/**
 * "Attach <name> to": the tab's own session, each other session of its connection, or a new
 * one (spec: session-manager › Switch session). Rendered through `AnchoredMenu`, so the panel's
 * clipping never hides it.
 */
export function SwitchSessionMenu({
  session,
  tabId,
  anchor,
  onClose,
}: {
  /** The session the tab runs on now. */
  session: SessionMeta;
  /** The tab being attached; the session's own tab when omitted. */
  tabId?: string;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(anchor);
  ref.current = anchor;
  const sessions = useSessions((s) => s.sessions);
  const tabs = tabsOfSession(session.id);
  const tab = tabs.find((t) => t.id === (tabId ?? session.tabId)) ?? (tabId ? undefined : tabs[0]);
  if (!tab) return null;
  const tabName = (t: typeof tab) =>
    t.id === (session.tabId ?? tabs[0]?.id) ? session.name : tabTitle(t);
  const others = Object.values(sessions).filter(
    (s) =>
      s.connectionId === session.connectionId && s.id !== session.id && s.state !== "disconnected",
  );
  const own = tab.id === (session.tabId ?? tabs[0]?.id);
  const items = [
    { id: "title", label: `ATTACH ${tabName(tab)} TO`, disabled: true },
    { id: "own", label: "its own session", hint: own ? "✓" : undefined },
    ...others.map((s) => ({ id: `session:${s.id}`, label: s.name })),
    { id: "new", label: "New session", separatorBefore: true },
  ];
  return (
    <AnchoredMenu anchor={ref}>
      <Menu
        aria-label={`Attach ${tabName(tab)} to`}
        style={{ width: 300 }}
        items={items}
        onClose={onClose}
        onSelect={(id) => {
          onClose();
          const connectionId = session.connectionId;
          if (id === "own") {
            if (!own) void attachTab(tab.id, connectionId, { kind: "own" });
          } else if (id === "new") void attachTab(tab.id, connectionId, { kind: "new" });
          else void attachTab(tab.id, connectionId, { kind: "session", id: id.slice(8) });
        }}
      />
    </AnchoredMenu>
  );
}
