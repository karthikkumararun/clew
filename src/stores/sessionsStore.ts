import { create } from "zustand";
import { useConnections } from "../connections/connectionsStore";
import { sessionsSubscribe } from "../features/sessions/api";
import type { SessionEvent, SessionMeta } from "../features/sessions/types";
import { useNotices } from "./noticesStore";
import { idleThresholdMs, notifiesFor, useSessionSettings } from "./sessionSettings";

/** The idle ticker runs once for the whole app. */
export const IDLE_TICK_MS = 15_000;

export type Selection = { kind: "session"; id: string } | { kind: "connection"; id: string } | null;

/** What the notification's buttons do; wired by the sessions feature (avoids an import cycle). */
export interface IdleNoticeHandlers {
  rollback: (session: SessionMeta) => void;
  show: (session: SessionMeta) => void;
}

interface SessionsState {
  sessions: Record<string, SessionMeta>;
  /** Insertion order, so the tree is stable while states change. */
  order: string[];
  /** Whether the backend subscription has delivered its snapshot. */
  ready: boolean;
  selection: Selection;
  filter: string;
  /** Connections whose sessions were all closed by Deactivate; they stay listed as disconnected. */
  deactivated: string[];
  /** Collapsed connection rows (all are expanded by default). */
  collapsed: string[];
  now: number;
  /** Sessions in a transaction with no activity for longer than the threshold. */
  idle: Record<string, true>;
  /** The transaction start the notification was already shown for, per session. */
  notified: Record<string, number>;

  apply: (event: SessionEvent) => void;
  select: (selection: Selection) => void;
  setFilter: (filter: string) => void;
  toggleCollapsed: (connectionId: string) => void;
  markDeactivated: (connectionId: string, deactivated: boolean) => void;
  /** Advance the clock, recompute idle flags, notify once per transaction. */
  tick: (now?: number) => void;
}

let handlers: IdleNoticeHandlers | null = null;
export function setIdleNoticeHandlers(next: IdleNoticeHandlers | null) {
  handlers = next;
}

const environmentOf = (connectionId: string) =>
  useConnections.getState().file.connections.find((c) => c.id === connectionId)?.environment;

/** Is this session an idle-in-transaction one at `now`? */
export function isIdleInTransaction(session: SessionMeta, now: number): boolean {
  if (session.state !== "in_transaction") return false;
  const threshold = idleThresholdMs(environmentOf(session.connectionId));
  return now - session.lastActivityAt >= threshold;
}

function flagsOf(sessions: Record<string, SessionMeta>, now: number): Record<string, true> {
  const out: Record<string, true> = {};
  for (const s of Object.values(sessions)) if (isIdleInTransaction(s, now)) out[s.id] = true;
  return out;
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: {},
  order: [],
  ready: false,
  selection: null,
  filter: "",
  deactivated: [],
  collapsed: [],
  now: Date.now(),
  idle: {},
  notified: {},

  apply: (event) => {
    const prev = get();
    let sessions = prev.sessions;
    let order = prev.order;
    if (event.kind === "snapshot") {
      sessions = Object.fromEntries(event.sessions.map((s) => [s.id, s]));
      order = event.sessions.map((s) => s.id);
    } else if (event.kind === "upsert") {
      sessions = { ...sessions, [event.session.id]: event.session };
      if (!order.includes(event.session.id)) order = [...order, event.session.id];
    } else {
      if (!(event.id in sessions)) return;
      sessions = { ...sessions };
      delete sessions[event.id];
      order = order.filter((id) => id !== event.id);
    }
    const deactivated = prev.deactivated.filter(
      (id) => !Object.values(sessions).some((s) => s.connectionId === id),
    );
    set({
      sessions,
      order,
      ready: true,
      deactivated,
      idle: flagsOf(sessions, get().now),
      selection:
        prev.selection?.kind === "session" && !(prev.selection.id in sessions)
          ? null
          : prev.selection,
    });
    // A flag may be due the moment an event arrives, not only on the next tick.
    get().tick();
  },

  select: (selection) => set({ selection }),
  setFilter: (filter) => set({ filter }),
  toggleCollapsed: (connectionId) =>
    set((s) => ({
      collapsed: s.collapsed.includes(connectionId)
        ? s.collapsed.filter((id) => id !== connectionId)
        : [...s.collapsed, connectionId],
    })),
  markDeactivated: (connectionId, on) =>
    set((s) => ({
      deactivated: on
        ? s.deactivated.includes(connectionId)
          ? s.deactivated
          : [...s.deactivated, connectionId]
        : s.deactivated.filter((id) => id !== connectionId),
    })),

  tick: (at) => {
    const now = at ?? Date.now();
    const { sessions, notified } = get();
    const idle = flagsOf(sessions, now);
    // Forget notifications of transactions that ended, so the next one notifies again.
    const kept: Record<string, number> = {};
    for (const [id, startedAt] of Object.entries(notified)) {
      if (sessions[id]?.state === "in_transaction" && sessions[id].txStartedAt === startedAt)
        kept[id] = startedAt;
    }
    const fresh: SessionMeta[] = [];
    for (const id of Object.keys(idle)) {
      const s = sessions[id];
      const startedAt = s.txStartedAt ?? s.lastActivityAt;
      if (kept[id] === startedAt) continue;
      kept[id] = startedAt;
      if (notifiesFor(environmentOf(s.connectionId))) fresh.push(s);
    }
    set({ now, idle, notified: kept });
    for (const s of fresh) announceIdle(s, now);
  },
}));

function announceIdle(session: SessionMeta, now: number) {
  const production = environmentOf(session.connectionId) === "production";
  const minutes = Math.max(1, Math.floor((now - session.lastActivityAt) / 60_000));
  const message = `${session.name} has had a transaction open and idle for ${minutes} min${
    production ? " on production" : ""
  }. It can hold locks and block other writers.`;
  useNotices.getState().push(message, [
    { label: "Roll back", onClick: () => handlers?.rollback(session) },
    { label: "Show", onClick: () => handlers?.show(session) },
  ]);
}

// ---- derived views ----------------------------------------------------------------------------

export const sessionList = (s: Pick<SessionsState, "sessions" | "order">): SessionMeta[] =>
  s.order.map((id) => s.sessions[id]).filter(Boolean);

export const inTransaction = (s: SessionMeta) =>
  s.state === "in_transaction" || s.state === "aborted";

/** Sessions that hold an open transaction, oldest first. */
export function openTransactions(sessions: SessionMeta[]): SessionMeta[] {
  return sessions
    .filter(inTransaction)
    .sort((a, b) => (a.txStartedAt ?? a.lastActivityAt) - (b.txStartedAt ?? b.lastActivityAt));
}

// ---- lifecycle --------------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Subscribe to the backend once and start the idle ticker. Returns a disposer. Outside the
 * desktop app (tests, a plain browser) the subscription fails quietly and the store stays empty.
 */
export function startSessionsSync(): () => void {
  let stopped = false;
  void sessionsSubscribe((event) => {
    if (!stopped) useSessions.getState().apply(event);
  }).catch(() => {});
  const offSettings = useSessionSettings.subscribe(() => useSessions.getState().tick());
  if (timer) clearInterval(timer);
  timer = setInterval(() => useSessions.getState().tick(), IDLE_TICK_MS);
  return () => {
    stopped = true;
    offSettings();
    if (timer) clearInterval(timer);
    timer = null;
  };
}

/** Test helper. */
export function resetSessions() {
  useSessions.setState({
    sessions: {},
    order: [],
    ready: false,
    selection: null,
    filter: "",
    deactivated: [],
    collapsed: [],
    now: Date.now(),
    idle: {},
    notified: {},
  });
}
