use std::collections::HashMap;

use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn ui_state_get(state: State<'_, AppState>, key: String) -> AppResult<Option<String>> {
    state.store.ui_state_get(&key).await
}

#[tauri::command]
pub async fn ui_state_set(state: State<'_, AppState>, key: String, value: String) -> AppResult<()> {
    state.store.ui_state_set(&key, &value).await
}

/// Everything at once: the frontend hydrates its synchronous cache at startup.
#[tauri::command]
pub async fn ui_state_all(state: State<'_, AppState>) -> AppResult<HashMap<String, String>> {
    state.store.ui_state_all().await
}
