use tauri::State;

use crate::connections::model::{ConnectionsFile, Group};
use crate::connections::service::{SaveOutcome, SaveRequest, SecretStatus};
use crate::connections::url::{parse_url, ParsedUrl};
use crate::drivers::Secret;
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub fn connections_list(state: State<'_, AppState>) -> AppResult<ConnectionsFile> {
    state.connections.list()
}

#[tauri::command]
pub fn connections_save(
    state: State<'_, AppState>,
    request: SaveRequest,
) -> AppResult<SaveOutcome> {
    state.connections.save(request)
}

/// Returns warnings (e.g. secrets that could not be removed from the keychain).
#[tauri::command]
pub async fn connections_delete(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<Vec<String>> {
    state.sessions.disconnect(&connection_id).await;
    state.connections.delete(&connection_id)
}

#[tauri::command]
pub fn connections_duplicate(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<SaveOutcome> {
    state.connections.duplicate(&connection_id)
}

#[tauri::command]
pub fn groups_save(state: State<'_, AppState>, group: Group) -> AppResult<Group> {
    state.connections.save_group(group)
}

#[tauri::command]
pub fn groups_delete(state: State<'_, AppState>, group_id: String) -> AppResult<()> {
    state.connections.delete_group(&group_id)
}

#[tauri::command]
pub fn connection_secret_status(state: State<'_, AppState>, connection_id: String) -> SecretStatus {
    state.connections.secret_status(&connection_id)
}

/// Answer a `password_prompt` event. `password: null` cancels.
#[tauri::command]
pub fn password_answer(
    state: State<'_, AppState>,
    prompt_id: String,
    password: Option<Secret>,
) -> bool {
    state.password_prompts.answer(&prompt_id, password)
}

/// Parse a pasted connection URL into a prefilled draft.
#[tauri::command]
pub fn connections_parse_url(url: String) -> AppResult<ParsedUrl> {
    parse_url(&url)
}
