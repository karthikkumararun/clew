import { getUiState, setUiState } from "../lib/uiState";
import { useWorkspace } from "../stores/workspaceStore";
import { getTabKind } from "./registry/tabKinds";
import type { Tab } from "./registry/tabKinds";

export const SESSION_KEY = "session.tabs";
const SESSION_VERSION = 1;
/** Cap on persisted editor content. Beyond it the largest tabs are not restored (files reopen from disk). */
export const MAX_SESSION_BYTES = 5 * 1024 * 1024;
const DEBOUNCE_MS = 500;

interface StoredTab {
  id: string;
  kind: string;
  key: string;
  state: unknown;
}

interface StoredSession {
  version: number;
  activeTabId: string | null;
  tabs: StoredTab[];
}

export function serializeSession(tabs: Tab[], activeTabId: string | null): string {
  const stored: { tab: StoredTab; size: number }[] = [];
  for (const t of tabs) {
    const kind = getTabKind(t.kind);
    if (!kind) continue;
    const state = kind.serialize ? kind.serialize(t.state) : t.state;
    const tab: StoredTab = { id: t.id, kind: t.kind, key: t.key, state };
    stored.push({ tab, size: JSON.stringify(tab).length });
  }
  let total = stored.reduce((n, s) => n + s.size, 0);
  // Over budget: drop the largest tabs until it fits.
  const bySize = [...stored].sort((a, b) => b.size - a.size);
  const dropped = new Set<StoredTab>();
  for (const s of bySize) {
    if (total <= MAX_SESSION_BYTES) break;
    dropped.add(s.tab);
    total -= s.size;
  }
  const kept = stored.filter((s) => !dropped.has(s.tab)).map((s) => s.tab);
  const session: StoredSession = {
    version: SESSION_VERSION,
    activeTabId: kept.some((t) => t.id === activeTabId) ? activeTabId : (kept[0]?.id ?? null),
    tabs: kept,
  };
  return JSON.stringify(session);
}

export function parseSession(raw: string | null): { tabs: Tab[]; activeTabId: string | null } {
  if (!raw) return { tabs: [], activeTabId: null };
  try {
    const data = JSON.parse(raw) as Partial<StoredSession>;
    if (data.version !== SESSION_VERSION || !Array.isArray(data.tabs)) throw new Error("shape");
    const tabs: Tab[] = [];
    for (const t of data.tabs) {
      if (!t || typeof t.id !== "string" || typeof t.kind !== "string" || typeof t.key !== "string")
        continue;
      const kind = getTabKind(t.kind);
      if (!kind) continue; // editor type not available in this build
      try {
        tabs.push({
          id: t.id,
          kind: t.kind,
          key: t.key,
          state: kind.deserialize ? kind.deserialize(t.state) : t.state,
        });
      } catch {
        /* skip a tab whose saved state no longer deserializes */
      }
    }
    return { tabs, activeTabId: data.activeTabId ?? null };
  } catch {
    return { tabs: [], activeTabId: null };
  }
}

/**
 * Where the open tabs are saved. Workspaces point this at the active workspace; the default is
 * the Last session, which keeps the key a session had before workspaces existed.
 */
let target: () => string = () => SESSION_KEY;
export function setSessionTarget(next: () => string): void {
  target = next;
}

let suspended = 0;
/** Pause saving (while a workspace switch replaces the tabs); the returned function resumes it. */
export function suspendSessionPersistence(): () => void {
  suspended += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    suspended -= 1;
  };
}

type AfterPersist = (tabs: Tab[], activeTabId: string | null) => void;
const afterPersist = new Set<AfterPersist>();
/** Called after every save with the tabs that were saved (per-connection default workspaces). */
export function onSessionPersisted(listener: AfterPersist): () => void {
  afterPersist.add(listener);
  return () => afterPersist.delete(listener);
}

export function persistSession() {
  if (suspended > 0) return;
  const { tabs, activeTabId } = useWorkspace.getState();
  setUiState(target(), serializeSession(tabs, activeTabId));
  afterPersist.forEach((l) => l(tabs, activeTabId));
}

/** Reopen the tabs from the last run (without connecting to anything). */
export function restoreSession() {
  const { tabs, activeTabId } = parseSession(getUiState(target()));
  if (tabs.length > 0) useWorkspace.getState().restoreTabs(tabs, activeTabId);
}

/** Save the open tabs 500ms after the last change, and immediately when the window goes away. */
export function startSessionPersistence(): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = useWorkspace.subscribe((state, prev) => {
    if (state.tabs === prev.tabs && state.activeTabId === prev.activeTabId) return;
    clearTimeout(timer);
    timer = setTimeout(persistSession, DEBOUNCE_MS);
  });
  const flush = () => {
    clearTimeout(timer);
    persistSession();
  };
  window.addEventListener("pagehide", flush);
  window.addEventListener("beforeunload", flush);
  return () => {
    unsubscribe();
    clearTimeout(timer);
    window.removeEventListener("pagehide", flush);
    window.removeEventListener("beforeunload", flush);
  };
}
