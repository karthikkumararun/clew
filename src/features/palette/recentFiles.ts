import { getUiState, setUiState } from "../../lib/uiState";
import { useWorkspace } from "../../stores/workspaceStore";
import type { ConsoleState } from "../console/state";
import { CONSOLE_KIND } from "../console/state";

/** A SQL file that was opened in a console (spec: command-palette › Recent files and queries). */
export interface RecentFile {
  path: string;
  connectionId: string;
  openedAt: number;
}

const KEY = "palette.recentFiles";
const LIMIT = 30;

export function readRecentFiles(): RecentFile[] {
  try {
    const parsed: unknown = JSON.parse(getUiState(KEY) ?? "[]");
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (f): f is RecentFile =>
        !!f &&
        typeof f.path === "string" &&
        typeof f.connectionId === "string" &&
        typeof f.openedAt === "number",
    );
  } catch {
    return [];
  }
}

export function rememberFile(file: Omit<RecentFile, "openedAt">, now = Date.now()): void {
  const rest = readRecentFiles().filter((f) => f.path !== file.path);
  setUiState(KEY, JSON.stringify([{ ...file, openedAt: now }, ...rest].slice(0, LIMIT)));
}

/** Record every file a console gets bound to, however it was opened. Returns a disposer. */
export function startRecentFiles(): () => void {
  const seen = new Set<string>();
  const visit = () => {
    for (const tab of useWorkspace.getState().tabs) {
      if (tab.kind !== CONSOLE_KIND) continue;
      const s = tab.state as ConsoleState;
      if (!s.filePath || seen.has(`${tab.id}:${s.filePath}`)) continue;
      seen.add(`${tab.id}:${s.filePath}`);
      rememberFile({ path: s.filePath, connectionId: s.connectionId });
    }
  };
  visit();
  return useWorkspace.subscribe(visit);
}
