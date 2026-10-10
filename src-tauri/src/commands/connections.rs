use tauri::State;

use crate::connections::model::{ConnectionsFile, Group};
use crate::connections::service::{SaveOutcome, SaveRequest, SecretStatus};
use crate::connections::url::{parse_url, ParsedUrl};
use crate::drivers::{DriverError, ErrorCode, Secret, ServerInfo};
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

/// "Test connection" from the dialog: connect with the unsaved draft (typed secrets win over
/// stored ones), report the server, save nothing. Cancellable through `connections_test_cancel`.
#[tauri::command]
pub async fn connections_test(
    state: State<'_, AppState>,
    request: SaveRequest,
    test_id: String,
) -> AppResult<ServerInfo> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    state
        .test_cancels
        .lock()
        .unwrap()
        .insert(test_id.clone(), tx);
    let work = async {
        let config = state.connections.resolve_draft(&request).await?;
        state.sessions.test_connection(&config).await
    };
    let result = tokio::select! {
        r = work => r,
        _ = rx => Err(DriverError::new(ErrorCode::Cancelled, "Test cancelled")),
    };
    state.test_cancels.lock().unwrap().remove(&test_id);
    Ok(result?)
}

#[tauri::command]
pub fn connections_test_cancel(state: State<'_, AppState>, test_id: String) {
    if let Some(tx) = state.test_cancels.lock().unwrap().remove(&test_id) {
        let _ = tx.send(());
    }
}
