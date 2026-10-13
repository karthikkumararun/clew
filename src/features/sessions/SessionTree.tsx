import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { DriverBadge, ENV_COLORS } from "../../components/Badge";
import { ChevronDown, ChevronRight, Terminal, Warning } from "../../components/icons";
import { BADGE_ENV, badgeDriver } from "../../connections/display";
import { useSessions } from "../../stores/sessionsStore";
import { connectionSummary, rowDetail, stateColor, stateText } from "./format";
import { stopsOf } from "./model";
import type { ConnectionNode, Stop } from "./model";
import { tabsOfSession } from "./tabs";
import type { SessionMeta } from "./types";
import styles from "./Sessions.module.css";

const ENV_LABEL: Record<string, string> = {
  local: "LOCAL",
  development: "DEVELOPMENT",
  staging: "STAGING",
  production: "PRODUCTION",
};

/** Tabs that share a session with its first tab, for the rows nested under it. */
const sharedTabsOf = (s: SessionMeta) =>
  tabsOfSession(s.id)
    .filter((t) => t.id !== (s.tabId ?? tabsOfSession(s.id)[0]?.id))
    .map((t) => ({ id: t.id }));

/**
 * Connections with their sessions, as an ARIA tree. Up/Down move, Home/End jump, Right expands
 * (or steps into) a connection, Left collapses (or steps out to) it, Enter selects, and
 * Shift+F10 / the context-menu key opens "Attach to".
 */
export function SessionTree({
  nodes,
  tabName,
  onAttachMenu,
}: {
  nodes: ConnectionNode[];
  tabName: (tabId: string) => string;
  /** Open the Switch session menu for a session, anchored at its row. */
  onAttachMenu: (session: SessionMeta, anchor: HTMLElement, tabId?: string) => void;
}) {
  const selection = useSessions((s) => s.selection);
  const collapsed = useSessions((s) => s.collapsed);
  const idle = useSessions((s) => s.idle);
  const now = useSessions((s) => s.now);
  const select = useSessions((s) => s.select);
  const toggle = useSessions((s) => s.toggleCollapsed);
  const rows = useRef(new Map<string, HTMLDivElement>());
  const stops = stopsOf(nodes, collapsed, sharedTabsOf);
  const [focusId, setFocusId] = useState<string | null>(null);

  const selectedKey =
    selection?.kind === "connection"
      ? selection.id
      : selection?.kind === "session"
        ? selection.id
        : null;
  const tabStop =
    (focusId && stops.find((s) => s.id === focusId)?.id) ||
    stops.find((s) => s.id === selectedKey)?.id ||
    stops[0]?.id;

  useEffect(() => {
    if (focusId && !stops.some((s) => s.id === focusId)) setFocusId(null);
  }, [focusId, stops]);

  const sessionOf = (id: string) => nodes.flatMap((n) => n.sessions).find((s) => s.id === id);

  const go = (stop: Stop | undefined) => {
    if (!stop) return;
    setFocusId(stop.id);
    rows.current.get(stop.id)?.focus();
    select(
      stop.kind === "connection"
        ? { kind: "connection", id: stop.id }
        : { kind: "session", id: stop.kind === "shared" ? stop.sessionId : stop.id },
    );
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>, stop: Stop, index: number) => {
    switch (e.key) {
      case "ArrowDown":
        go(stops[index + 1]);
        break;
      case "ArrowUp":
        go(stops[index - 1]);
        break;
      case "Home":
        go(stops[0]);
        break;
      case "End":
        go(stops[stops.length - 1]);
        break;
      case "ArrowRight":
        if (stop.kind === "connection") {
          if (collapsed.includes(stop.id)) toggle(stop.id);
          else if (stops[index + 1]?.parent === stop.id) go(stops[index + 1]);
        }
        break;
      case "ArrowLeft":
        if (stop.kind === "connection") {
          if (!collapsed.includes(stop.id)) toggle(stop.id);
        } else go(stops.find((s) => s.id === stop.parent));
        break;
      case "Enter":
      case " ":
        go(stop);
        break;
      case "ContextMenu":
      case "F10": {
        if (e.key === "F10" && !e.shiftKey) return;
        const s =
          stop.kind === "connection"
            ? undefined
            : sessionOf(stop.kind === "shared" ? stop.sessionId : stop.id);
        const el = rows.current.get(stop.id);
        if (s && el) onAttachMenu(s, el, stop.kind === "shared" ? stop.tabId : undefined);
        break;
      }
      default:
        return;
    }
    e.preventDefault();
  };

  if (stops.length === 0) {
    return (
      <div role="tree" aria-label="Sessions by connection" className={styles.tree}>
        <p className={styles.empty}>No sessions. Open a console to start one.</p>
      </div>
    );
  }

  return (
    <div role="tree" aria-label="Sessions by connection" className={styles.tree}>
      {nodes.map((n) => {
        const c = n.connection;
        const open = !collapsed.includes(c.id);
        const env = ENV_COLORS[BADGE_ENV[c.environment]];
        const index = stops.findIndex((s) => s.id === c.id);
        const cSelected = selection?.kind === "connection" && selection.id === c.id;
        return (
          <div key={c.id} role="none">
            <div
              ref={(el) => {
                if (el) rows.current.set(c.id, el);
                else rows.current.delete(c.id);
              }}
              role="treeitem"
              aria-level={1}
              aria-expanded={open}
              aria-selected={cSelected}
              tabIndex={tabStop === c.id ? 0 : -1}
              className={`${styles.row} ${styles.connection}`}
              data-environment={c.environment}
              onClick={() => {
                setFocusId(c.id);
                select({ kind: "connection", id: c.id });
              }}
              onKeyDown={(e) => onKeyDown(e, stops[index], index)}
            >
              <span
                className={styles.twisty}
                onClick={(e) => {
                  e.stopPropagation();
                  toggle(c.id);
                }}
                aria-hidden="true"
              >
                {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
              <DriverBadge driver={badgeDriver(c.driver)} />
              <span className={styles.name}>{c.name}</span>
              <span className={styles.envDot} style={{ background: env }} aria-hidden="true" />
              <span className={styles.envLabel}>{ENV_LABEL[c.environment] ?? c.environment}</span>
              <span className={styles.summary}>
                {connectionSummary(n.sessions, n.disconnected)}
              </span>
            </div>
            {open
              ? n.sessions.map((s) => {
                  const i = stops.findIndex((x) => x.id === s.id);
                  const production = c.environment === "production";
                  const flagged = Boolean(idle[s.id]);
                  const selected = selection?.kind === "session" && selection.id === s.id;
                  const shared = sharedTabsOf(s);
                  const waiting = s.waitingFor;
                  return (
                    <div key={s.id} role="none">
                      <div
                        ref={(el) => {
                          if (el) rows.current.set(s.id, el);
                          else rows.current.delete(s.id);
                        }}
                        role="treeitem"
                        aria-level={2}
                        aria-selected={selected}
                        tabIndex={tabStop === s.id ? 0 : -1}
                        className={`${styles.row} ${styles.session}`}
                        data-state={s.state}
                        data-flagged={flagged}
                        onClick={() => {
                          setFocusId(s.id);
                          select({ kind: "session", id: s.id });
                        }}
                        onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => {
                          e.preventDefault();
                          select({ kind: "session", id: s.id });
                          onAttachMenu(s, e.currentTarget);
                        }}
                        onKeyDown={(e) => onKeyDown(e, stops[i], i)}
                      >
                        <span className={styles.rowIcon} aria-hidden="true">
                          <Terminal size={13} />
                        </span>
                        <span className={styles.name}>{s.name}</span>
                        <span
                          className={styles.state}
                          style={{ color: stateColor(s.state, production) }}
                        >
                          {stateText(s, now)}
                          {flagged ? (
                            <span role="img" aria-label="Idle in transaction">
                              <Warning size={12} />
                            </span>
                          ) : null}
                        </span>
                        <span className={styles.detail}>
                          {waiting ? (
                            <span className={styles.waiting}>Waiting for {waiting}</span>
                          ) : (
                            rowDetail(s)
                          )}
                        </span>
                      </div>
                      {shared.map((t) => {
                        const key = `${s.id}:${t.id}`;
                        const j = stops.findIndex((x) => x.id === key);
                        return (
                          <div
                            key={key}
                            ref={(el) => {
                              if (el) rows.current.set(key, el);
                              else rows.current.delete(key);
                            }}
                            role="treeitem"
                            aria-level={3}
                            aria-selected={false}
                            tabIndex={tabStop === key ? 0 : -1}
                            className={`${styles.row} ${styles.shared}`}
                            onClick={() => {
                              setFocusId(key);
                              select({ kind: "session", id: s.id });
                            }}
                            onContextMenu={(e: ReactMouseEvent<HTMLDivElement>) => {
                              e.preventDefault();
                              select({ kind: "session", id: s.id });
                              onAttachMenu(s, e.currentTarget, t.id);
                            }}
                            onKeyDown={(e) => onKeyDown(e, stops[j], j)}
                          >
                            <span className={styles.rowIcon} aria-hidden="true">
                              <Terminal size={13} />
                            </span>
                            <span className={styles.name}>{tabName(t.id)}</span>
                            <span className={styles.detail}>shares {s.name}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })
              : null}
          </div>
        );
      })}
    </div>
  );
}
