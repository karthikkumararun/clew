import { isTauri, tauriUiStateBackend } from "./lib/ipc";
import { hydrateUiState, setUiStateBackend } from "./lib/uiState";
import { startCopilotSync } from "./features/ai/copilotStore";
import { useAiSettings } from "./features/ai/settingsStore";
import { startSnapshotSync } from "./features/console/completionTarget";
import { registerConsoleTab } from "./features/console/ConsoleTab";
import { startFileSync } from "./features/console/fileSync";
import { registerCollectionTab } from "./features/documents/CollectionTab";
import { registerGraphTab } from "./features/graph/GraphTab";
import { registerKeysTab } from "./features/key-value/KeysTab";
import { registerTableTab } from "./features/table-editor/TableTab";
import { startExplorerSync, useExplorer } from "./features/explorer/explorerStore";
import { rehydrateLayout } from "./stores/layoutStore";
import { startSessionsSync } from "./stores/sessionsStore";
import { useSessionSettings } from "./stores/sessionSettings";
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
  useSessionSettings.getState().rehydrate();
  startSessionsSync();
  useExplorer.getState().rehydrate();
  startExplorerSync();
  startSnapshotSync();
  startFileSync();
  await useSettings.getState().load();
  void useAiSettings.getState().load();
  startCopilotSync();
  applySettingsToDocument(useSettings.getState().settings);
  useSettings.subscribe((s) => applySettingsToDocument(s.settings));
  // Editor kinds must exist before the last session is reopened.
  registerConsoleTab();
  registerTableTab();
  registerCollectionTab();
  registerKeysTab();
  registerGraphTab();
  restoreSession();
  startSessionPersistence();
}
