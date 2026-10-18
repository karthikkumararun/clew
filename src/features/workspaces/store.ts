import { create } from "zustand";
import { useConnections } from "../../connections/connectionsStore";
import { useWorkspace, isTabDirty } from "../../stores/workspaceStore";
import { getTabKind } from "../../shell/registry/tabKinds";
import type { Tab } from "../../shell/registry/tabKinds";
import {
  persistSession,
  serializeSession,
  setSessionTarget,
  suspendSessionPersistence,
  onSessionPersisted,
} from "../../shell/session";
import { openConsole } from "../console/commands";
import { askChoice } from "../console/prompts";
import { CONSOLE_KIND, baseName } from "../console/state";
import type { ConsoleState } from "../console/state";
import {
  LAST_ID,
  LAST_NAME,
  blobKey,
  clearBlob,
  connectionWorkspaceId,
  environmentOf,
  readBlob,
  readIndex,
  tabsOf,
  writeBlob,
  writeIndex,
} from "./model";
import type { WorkspaceMeta, WorkspaceRow } from "./model";

interface WorkspacesState {
  items: WorkspaceMeta[];
  activeId: string;
  /** The switcher menu and the manage dialog. */
  menuOpen: boolean;
  manageOpen: boolean;
  saveAsOpen: boolean;
  newOpen: boolean;
  /** Re-read the index (at start, and after anything outside this store changes it). */
  load: () => void;
  setMenuOpen: (open: boolean) => void;
  setManageOpen: (open: boolean) => void;
  setSaveAsOpen: (open: boolean) => void;
  setNewOpen: (open: boolean) => void;
}

export const useWorkspaces = create<WorkspacesState>((set) => ({
  items: readIndex().items,
  activeId: LAST_ID,
  menuOpen: false,
  manageOpen: false,
  saveAsOpen: false,
  newOpen: false,
  load: () => {
    const { items, activeId } = readIndex();
    set({ items, activeId });
  },
  setMenuOpen: (menuOpen) => set({ menuOpen }),
  setManageOpen: (manageOpen) => set({ manageOpen }),
  setSaveAsOpen: (saveAsOpen) => set({ saveAsOpen }),
  setNewOpen: (newOpen) => set({ newOpen }),
}));

const state = () => useWorkspaces.getState();

/** Save the index and mirror it in the store. */
function commitIndex(items: WorkspaceMeta[], activeId: string): void {
  writeIndex({ items, activeId });
  useWorkspaces.setState({ items, activeId });
}

/** The name shown for a workspace: connection defaults follow the connection's name. */
export function displayName(meta: WorkspaceMeta): string {
  if (meta.kind === "connection" && meta.connectionId) {
    const c = useConnections.getState().file.connections.find((x) => x.id === meta.connectionId);
    if (c) return c.name;
  }
  return meta.name;
}

/** Rows for the switcher, with the environment derived now from the connections. */
export function workspaceRows(): WorkspaceRow[] {
  const { items, activeId } = state();
  const live = useWorkspace.getState().tabs;
  return items.map((meta) => {
    const tabs = meta.id === activeId ? live : tabsOf(meta.id).tabs;
    return {
      meta: { ...meta, name: displayName(meta) },
      env: environmentOf(tabs),
      tabCount: tabs.length,
    };
  });
}

/** Start: read the index and make saving follow the active workspace. */
export function startWorkspaces(): () => void {
  state().load();
  setSessionTarget(() => blobKey(state().activeId));
  return onSessionPersisted(updateConnectionDefaults);
}

const lastWritten = new Map<string, string>();

/**
 * Consoles opened or edited for a connection update that connection's default workspace (spec:
 * workspaces › Default workspace per connection). A connection with no console is left alone, so
 * closing its tabs does not erase what "Open workspace" brings back.
 */
function updateConnectionDefaults(tabs: Tab[], activeTabId: string | null): void {
  const byConnection = new Map<string, Tab[]>();
  for (const t of tabs) {
    if (t.kind !== CONSOLE_KIND) continue;
    const id = (t.state as ConsoleState).connectionId;
    if (!id) continue;
    byConnection.set(id, [...(byConnection.get(id) ?? []), t]);
  }
  let items = state().items;
  let added = false;
  for (const [connectionId, group] of byConnection) {
    const id = connectionWorkspaceId(connectionId);
    // While it is the active workspace it is saved as a whole, by the session itself.
    if (id === state().activeId) continue;
    const raw = serializeSession(
      group,
      group.some((t) => t.id === activeTabId) ? activeTabId : null,
    );
    if (lastWritten.get(id) !== raw) {
      writeBlob(id, raw);
      lastWritten.set(id, raw);
    }
    if (!items.some((i) => i.id === id)) {
      const name =
        useConnections.getState().file.connections.find((c) => c.id === connectionId)?.name ??
        "Connection";
      items = [...items, { id, name, kind: "connection", connectionId, updatedAt: Date.now() }];
      added = true;
    }
  }
  if (added) commitIndex(items, state().activeId);
}

/** Ask what to do with unsaved files and open transactions before the tabs are replaced. */
async function mayLeaveTabs(): Promise<boolean> {
  for (const t of useWorkspace.getState().tabs) {
    const kind = getTabKind(t.kind);
    if (!kind || !isTabDirty(t)) continue;
    const s = t.state as ConsoleState;
    const answer = await askChoice({
      title: "Unsaved changes",
      body: `${s.filePath ? baseName(s.filePath) : kind.title(t.state as never)} has changes that are not saved to its file.`,
      choices: [
        { id: "cancel", label: "Cancel" },
        { id: "discard", label: "Discard" },
        { id: "save", label: "Save", variant: "primary" },
      ],
    });
    if (answer === "save") {
      if (!(await kind.save?.(t))) return false;
    } else if (answer === "discard") {
      // Back to what the file holds, so the workspace does not bring the changes back.
      if (s.savedText !== undefined) {
        useWorkspace.getState().updateTabState<ConsoleState>(t.id, { text: s.savedText });
      }
    } else {
      return false;
    }
  }
  for (const t of useWorkspace.getState().tabs) {
    if (getTabKind(t.kind)?.confirmClose && !(await getTabKind(t.kind)?.confirmClose?.(t))) {
      return false;
    }
  }
  return true;
}

/**
 * Make `id` the open workspace (spec: workspaces › Switching workspaces): save the current one,
 * settle unsaved files and transactions (cancelling leaves everything as it was), then replace
 * the tabs. Nothing runs and nothing connects.
 */
export async function switchTo(id: string): Promise<boolean> {
  if (id === state().activeId) return true;
  if (!state().items.some((i) => i.id === id)) return false;
  persistSession(); // the workspace being left keeps its tabs, whatever happens next
  if (!(await mayLeaveTabs())) return false;
  persistSession(); // again, with any discarded changes reverted
  replaceTabs(id, tabsOf(id));
  return true;
}

/** Replace the open tabs (releasing the old ones) and make `id` the open workspace. */
function replaceTabs(id: string, next: { tabs: Tab[]; activeTabId: string | null }): void {
  const resume = suspendSessionPersistence();
  try {
    for (const t of useWorkspace.getState().tabs) getTabKind(t.kind)?.onClose?.(t);
    useWorkspace.getState().restoreTabs(next.tabs, next.activeTabId);
    commitIndex(state().items, id);
  } finally {
    resume();
  }
  persistSession();
}

export type NameResult = { ok: true; id: string } | { ok: false; error: string };

const nameProblem = (name: string, exceptId?: string): string | null => {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name";
  const clash = state().items.some(
    (i) => i.id !== exceptId && displayName(i).toLowerCase() === trimmed.toLowerCase(),
  );
  return clash ? "A workspace with this name already exists" : null;
};

const newWorkspaceId = () =>
  `ws-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * Start an empty named workspace and switch to it, leaving the current one as it is (spec:
 * workspaces › Starting a workspace). Closing tabs instead would empty the workspace being left.
 */
export async function newWorkspace(name: string): Promise<NameResult> {
  const problem = nameProblem(name);
  if (problem) return { ok: false, error: problem };
  persistSession();
  if (!(await mayLeaveTabs())) return { ok: false, error: "The switch was cancelled" };
  persistSession();
  const id = newWorkspaceId();
  writeBlob(id, serializeSession([], null));
  commitIndex(
    [...state().items, { id, name: name.trim(), kind: "named", updatedAt: Date.now() }],
    state().activeId,
  );
  replaceTabs(id, { tabs: [], activeTabId: null });
  return { ok: true, id };
}

/** Save the open tabs as a named workspace and keep working in it. */
export function saveAs(name: string): NameResult {
  const problem = nameProblem(name);
  if (problem) return { ok: false, error: problem };
  persistSession();
  const { tabs, activeTabId } = useWorkspace.getState();
  const id = newWorkspaceId();
  writeBlob(id, serializeSession(tabs, activeTabId));
  commitIndex(
    [...state().items, { id, name: name.trim(), kind: "named", updatedAt: Date.now() }],
    id,
  );
  return { ok: true, id };
}

export function rename(id: string, name: string): NameResult {
  const meta = state().items.find((i) => i.id === id);
  if (!meta || meta.kind === "last") return { ok: false, error: "This workspace can't be renamed" };
  const problem = nameProblem(name, id);
  if (problem) return { ok: false, error: problem };
  commitIndex(
    state().items.map((i) => (i.id === id ? { ...i, name: name.trim() } : i)),
    state().activeId,
  );
  return { ok: true, id };
}

/** A copy that shares nothing with the original: editing one does not change the other. */
export function duplicate(id: string): NameResult {
  const meta = state().items.find((i) => i.id === id);
  if (!meta) return { ok: false, error: "Workspace not found" };
  if (id === state().activeId) persistSession();
  const base = `${displayName(meta)} copy`;
  let name = base;
  for (let n = 2; state().items.some((i) => displayName(i) === name); n++) name = `${base} ${n}`;
  const copy = newWorkspaceId();
  writeBlob(copy, readBlob(id) ?? serializeSession([], null));
  commitIndex(
    [...state().items, { id: copy, name, kind: "named", updatedAt: Date.now() }],
    state().activeId,
  );
  return { ok: true, id: copy };
}

/**
 * Delete a workspace. The built-in Last session can't be deleted. Deleting the open one keeps its
 * tabs open (they continue as the Last session); the caller has already asked for confirmation.
 */
export function remove(id: string): boolean {
  const meta = state().items.find((i) => i.id === id);
  if (!meta || meta.kind === "last") return false;
  clearBlob(id);
  lastWritten.delete(id);
  const wasActive = state().activeId === id;
  commitIndex(
    state().items.filter((i) => i.id !== id),
    wasActive ? LAST_ID : state().activeId,
  );
  if (wasActive) persistSession();
  return true;
}

/**
 * "Open workspace" on a connection: restore its default workspace, or open one empty console
 * when it never had one (spec: workspaces › Default workspace per connection).
 */
export async function openConnectionWorkspace(connectionId: string): Promise<void> {
  const id = connectionWorkspaceId(connectionId);
  if (state().items.some((i) => i.id === id) && tabsOf(id).tabs.length > 0) {
    await switchTo(id);
    return;
  }
  await openConsole({ connectionId });
}

export { LAST_NAME };
