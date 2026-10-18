import { getUiState, setUiState } from "../../lib/uiState";
import type { Environment } from "../../components/Badge";
import { getTabKind } from "../../shell/registry/tabKinds";
import type { Tab } from "../../shell/registry/tabKinds";
import { SESSION_KEY, parseSession } from "../../shell/session";

/** A workspace is a named set of open tabs (spec: workspaces › Workspace model). */
export interface WorkspaceMeta {
  id: string;
  name: string;
  /** `last`: the tabs open when the app last quit; `connection`: a connection's default. */
  kind: "named" | "connection" | "last";
  connectionId?: string;
  updatedAt: number;
}

export const LAST_ID = "last";
export const LAST_NAME = "Last session";
const INDEX_KEY = "workspaces.index";
const INDEX_VERSION = 1;

export const connectionWorkspaceId = (connectionId: string) => `conn:${connectionId}`;
/** The Last session keeps its old storage key, so a session saved before workspaces existed is it. */
export const blobKey = (id: string) => (id === LAST_ID ? SESSION_KEY : `workspace.${id}`);

interface StoredIndex {
  version: number;
  activeId: string;
  items: WorkspaceMeta[];
}

export interface WorkspaceIndex {
  activeId: string;
  items: WorkspaceMeta[];
}

const lastItem = (): WorkspaceMeta => ({
  id: LAST_ID,
  name: LAST_NAME,
  kind: "last",
  updatedAt: 0,
});

/** The stored index; the built-in Last session is always in it. */
export function readIndex(): WorkspaceIndex {
  let items: WorkspaceMeta[] = [];
  let activeId = LAST_ID;
  try {
    const raw = getUiState(INDEX_KEY);
    const data = raw ? (JSON.parse(raw) as Partial<StoredIndex>) : null;
    if (data?.version === INDEX_VERSION && Array.isArray(data.items)) {
      items = data.items.filter(
        (i) => i && typeof i.id === "string" && typeof i.name === "string" && i.id !== LAST_ID,
      );
      if (typeof data.activeId === "string") activeId = data.activeId;
    }
  } catch {
    /* an unreadable index starts over: the blobs are still there */
  }
  if (activeId !== LAST_ID && !items.some((i) => i.id === activeId)) activeId = LAST_ID;
  return { activeId, items: [lastItem(), ...items] };
}

export function writeIndex(index: WorkspaceIndex): void {
  const stored: StoredIndex = {
    version: INDEX_VERSION,
    activeId: index.activeId,
    items: index.items.filter((i) => i.id !== LAST_ID),
  };
  setUiState(INDEX_KEY, JSON.stringify(stored));
}

export const readBlob = (id: string): string | null => getUiState(blobKey(id));
export const writeBlob = (id: string, raw: string): void => setUiState(blobKey(id), raw);
/** An emptied blob: the workspace row stays, the tabs are gone. */
export const clearBlob = (id: string): void => setUiState(blobKey(id), "");

export function tabsOf(id: string): { tabs: Tab[]; activeTabId: string | null } {
  return parseSession(readBlob(id) || null);
}

/** `mixed` when the consoles belong to different environments, or to none we know. */
export type WorkspaceEnv = Environment | "mixed";

/**
 * The environment of a workspace: the one its consoles' connections share (spec: workspaces ›
 * Environment grouping). Derived from the connections at the time, so editing a connection's
 * environment moves its workspaces.
 */
export function environmentOf(tabs: Tab[]): WorkspaceEnv {
  const envs = new Set<Environment>();
  for (const t of tabs) {
    const env = getTabKind(t.kind)?.env?.(t.state);
    if (env) envs.add(env);
  }
  return envs.size === 1 ? [...envs][0] : "mixed";
}

export const ENV_ORDER: WorkspaceEnv[] = ["local", "dev", "staging", "production", "mixed"];
export const ENV_LABEL: Record<WorkspaceEnv, string> = {
  local: "Local",
  dev: "Development",
  staging: "Staging",
  production: "Production",
  mixed: "Mixed",
};

export interface WorkspaceRow {
  meta: WorkspaceMeta;
  env: WorkspaceEnv;
  tabCount: number;
}

/** The rows of the switcher, grouped by environment in the fixed order. */
export function groupByEnvironment(
  rows: WorkspaceRow[],
): { env: WorkspaceEnv; rows: WorkspaceRow[] }[] {
  return ENV_ORDER.map((env) => ({
    env,
    rows: rows
      .filter((r) => r.env === env)
      .sort((a, b) => a.meta.name.localeCompare(b.meta.name, undefined, { sensitivity: "base" })),
  })).filter((g) => g.rows.length > 0);
}
