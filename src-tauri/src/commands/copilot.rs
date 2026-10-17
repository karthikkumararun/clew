use serde::Deserialize;
use tauri::State;

use crate::ai::config::COPILOT_ID;
use crate::ai::copilot::service::CopilotState;
use crate::ai::policy;
use crate::connections::model::Environment;
use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// The sign-in state as it is now.
#[tauri::command]
pub fn copilot_state(state: State<'_, AppState>) -> CopilotState {
    state.copilot.state()
}

/// Read the sign-in state from the component when it is installed (start-up, opening settings).
#[tauri::command]
pub fn copilot_refresh(state: State<'_, AppState>) {
    let svc = state.copilot.clone();
    tauri::async_runtime::spawn(async move { svc.refresh().await });
}

/// "Sign in with GitHub": asks for consent first when the component isn't installed.
#[tauri::command]
pub fn copilot_begin(state: State<'_, AppState>) {
    let svc = state.copilot.clone();
    tauri::async_runtime::spawn(async move { svc.begin().await });
}

#[tauri::command]
pub fn copilot_accept_consent(state: State<'_, AppState>) {
    let svc = state.copilot.clone();
    tauri::async_runtime::spawn(async move { svc.accept_consent().await });
}

#[tauri::command]
pub fn copilot_decline_consent(state: State<'_, AppState>) {
    let svc = state.copilot.clone();
    tauri::async_runtime::spawn(async move { svc.decline_consent().await });
}

#[tauri::command]
pub fn copilot_check_now(state: State<'_, AppState>) {
    let svc = state.copilot.clone();
    tauri::async_runtime::spawn(async move { svc.check_now().await });
}

#[tauri::command]
pub fn copilot_cancel(state: State<'_, AppState>) {
    let svc = state.copilot.clone();
    tauri::async_runtime::spawn(async move { svc.cancel().await });
}

#[tauri::command]
pub fn copilot_sign_out(state: State<'_, AppState>) {
    let svc = state.copilot.clone();
    tauri::async_runtime::spawn(async move { svc.sign_out().await });
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopilotCompleteInput {
    pub request_id: String,
    pub connection_id: String,
    /// One per console, so the server keeps a document for each.
    pub document_id: String,
    pub prefix: String,
    pub suffix: String,
}

/// Ghost-text suggestions from Copilot (spec: ai-inline-completion › Completion context and
/// limits). Empty when AI is off for the connection.
#[tauri::command]
pub async fn copilot_complete(
    state: State<'_, AppState>,
    input: CopilotCompleteInput,
) -> AppResult<Vec<String>> {
    state.ai.ensure_enabled()?;
    let settings = state.ai.settings();
    if settings.routing.inline.as_deref() != Some(COPILOT_ID) || !settings.copilot.inline {
        return Ok(Vec::new());
    }
    let production = state
        .connections
        .get(&input.connection_id)
        .map(|c| c.environment == Environment::Production)
        .unwrap_or(false);
    let access = policy::access(&settings.privacy, production);
    if !access.allowed || !access.sql {
        return Ok(Vec::new());
    }
    let token = state.ai.start(&input.request_id);
    let result = state
        .copilot
        .complete(&input.document_id, &input.prefix, &input.suffix, token)
        .await;
    state.ai.finish(&input.request_id);
    match result {
        Ok(v) => Ok(v),
        Err(m) if m == "cancelled" => Err(AppError::new("cancelled", "Cancelled")),
        Err(m) => Err(AppError::new("ai_error", m)),
    }
}
