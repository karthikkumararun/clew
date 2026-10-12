import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Write saved UI state (the `ui_state` table of `clew.db`) so the next start comes up in that
 * state: `seedUiState(dir, { "layout.sidebarOpen": "false" })` then `launchApp(data)`. The app has
 * created the table by its first start, so call this after the app has run once
 * (spec: e2e-testing › Persisted-state sweep).
 */
export function seedUiState(dataDir: string, state: Record<string, string>): void {
  const db = new DatabaseSync(join(dataDir, "clew.db"));
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    const put = db.prepare(
      "INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    );
    for (const [k, v] of Object.entries(state)) put.run(k, v);
  } finally {
    db.close();
  }
}

/** The saved layout keys the sweep combines (see `src/stores/layoutStore.ts`). */
export const LAYOUT_KEYS = {
  sidebar: "layout.sidebarOpen",
  sidePanel: "layout.sidePanelOpen",
} as const;
