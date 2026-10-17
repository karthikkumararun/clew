use tauri::State;

use crate::drivers::introspect::SchemaSnapshot;
use crate::error::AppResult;
use crate::history::HistoryEntry;
use crate::palette::{entries_from_snapshot, PaletteHit, PaletteStats, Scope, RESULT_LIMIT};
use crate::state::AppState;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Fold a fresh snapshot into the index (memory now, `clew.db` in the background).
pub fn index_snapshot(
    state: &AppState,
    connection_id: &str,
    driver: &str,
    database: &str,
    snapshot: &SchemaSnapshot,
) {
    let entries = entries_from_snapshot(connection_id, driver, database, snapshot, now_ms());
    state
        .palette
        .replace(connection_id, database, entries.clone());
    let store = state.store.clone();
    let (connection_id, database) = (connection_id.to_string(), database.to_string());
    tokio::spawn(async move {
        if let Err(e) = store
            .palette_replace(&connection_id, &database, &entries)
            .await
        {
            crate::applog::log(&format!("couldn't save the palette index: {e}"));
        }
    });
}

/// Fuzzy-search the object index; the UI merges the answer with queries and actions.
#[tauri::command]
pub fn palette_search(state: State<'_, AppState>, query: String, scope: Scope) -> Vec<PaletteHit> {
    state.palette.search(&query, &scope, RESULT_LIMIT)
}

#[tauri::command]
pub fn palette_stats(state: State<'_, AppState>) -> PaletteStats {
    state.palette.stats()
}

/// The newest successful statements across connections, for Queries.
#[tauri::command]
pub async fn palette_recent_queries(
    state: State<'_, AppState>,
    limit: Option<i64>,
) -> AppResult<Vec<HistoryEntry>> {
    state
        .store
        .history_recent(limit.unwrap_or(200).clamp(1, 1000))
        .await
}

/// Forget the whole index (it is rebuilt as connections introspect again).
#[tauri::command]
pub async fn palette_clear(state: State<'_, AppState>) -> AppResult<()> {
    state.palette.clear();
    state.store.palette_clear().await
}
