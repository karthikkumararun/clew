import { isTauri, tauriUiStateBackend } from "./lib/ipc";
import { hydrateUiState, setUiStateBackend } from "./lib/uiState";
import { startSnapshotSync } from "./features/console/completionTarget";
import { registerConsoleTab } from "./features/console/ConsoleTab";
import { startExplorerSync, useExplorer } from "./features/explorer/explorerStore";
import { rehydrateLayout } from "./stores/layoutStore";
import { applySettingsToDocument, useSettings } from "./stores/settingsStore";
import { restoreSession, startSessionPersistence } from "./shell/session";

/**
 * Load persisted state before the first render: UI state (pane sizes, open flags),
 * settings, and the open-tab session. Everything degrades to defaults on failure.
 */
export async function boot(): Promise<void> {
  if (isTauri()) setUiStateBackend(tauriUiStateBackend);
  try {
    await hydrateUiState();
  } catch {
    /* start with defaults */
  }
  rehydrateLayout();
  useExplorer.getState().rehydrate();
  startExplorerSync();
  startSnapshotSync();
  await useSettings.getState().load();
  applySettingsToDocument(useSettings.getState().settings);
  useSettings.subscribe((s) => applySettingsToDocument(s.settings));
  // Editor kinds must exist before the last session is reopened.
  registerConsoleTab();
  restoreSession();
  startSessionPersistence();
}
