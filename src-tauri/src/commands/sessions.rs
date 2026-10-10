use std::sync::Arc;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::State;

use crate::drivers::{
    ExecRequest, ExecSummary, FullValueRequest, NodePath, ResolvedConfig, ResultEvent, ResultId,
    SchemaSnapshot, ServerInfo, TreeNode, Value,
};
use crate::error::AppResult;
use crate::sessions::Emit;
use crate::state::AppState;

fn emitter(channel: Channel<ResultEvent>) -> Emit {
    Arc::new(move |event| channel.send(event).is_ok())
}

/// Connect, run a trivial round-trip and report the server. Saves nothing.
#[tauri::command]
pub async fn connection_test(
    state: State<'_, AppState>,
    config: ResolvedConfig,
) -> AppResult<ServerInfo> {
    Ok(state.sessions.test_connection(&config).await?)
}

/// Register a connection and open its metadata pool.
#[tauri::command]
pub async fn connection_connect(
    state: State<'_, AppState>,
    connection_id: String,
    config: ResolvedConfig,
) -> AppResult<()> {
    Ok(state.sessions.connect(&connection_id, config).await?)
}

#[tauri::command]
pub async fn connection_disconnect(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<()> {
    state.sessions.disconnect(&connection_id).await;
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedSession {
    pub session_id: String,
    pub server: ServerInfo,
    /// `via SSH <host>` when tunnelled.
    pub transport: Option<String>,
}

#[tauri::command]
pub async fn session_open(
    state: State<'_, AppState>,
    connection_id: String,
) -> AppResult<OpenedSession> {
    let opened = state.sessions.open_session(&connection_id).await?;
    Ok(OpenedSession {
        session_id: opened.session_id,
        server: opened.server,
        transport: opened.transport,
    })
}

#[tauri::command]
pub async fn session_close(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    Ok(state.sessions.close_session(&session_id).await?)
}

/// Execute a statement or script. Results stream over `on_event`; the returned summary is the
/// last statement's. Failures are emitted as events *and* returned.
#[tauri::command]
pub async fn query_execute(
    state: State<'_, AppState>,
    session_id: String,
    request: ExecRequest,
    on_event: Channel<ResultEvent>,
) -> AppResult<Option<ExecSummary>> {
    Ok(state
        .sessions
        .execute(&session_id, request, emitter(on_event))
        .await?)
}

/// Pull more rows of an open result. Returns whether more remain.
#[tauri::command]
pub async fn query_fetch_more(
    state: State<'_, AppState>,
    session_id: String,
    result_id: ResultId,
    count: usize,
    on_event: Channel<ResultEvent>,
) -> AppResult<bool> {
    Ok(state
        .sessions
        .fetch_more(&session_id, result_id, count, emitter(on_event))
        .await?)
}

#[tauri::command]
pub async fn query_cancel(state: State<'_, AppState>, session_id: String) -> AppResult<()> {
    Ok(state.sessions.cancel(&session_id).await?)
}

/// The untruncated value of one cell (for values the grid received with `truncated: true`).
#[tauri::command]
pub async fn value_fetch_full(
    state: State<'_, AppState>,
    session_id: String,
    request: FullValueRequest,
) -> AppResult<Value> {
    Ok(state
        .sessions
        .fetch_full_value(&session_id, request)
        .await?)
}

#[tauri::command]
pub async fn introspect_children(
    state: State<'_, AppState>,
    connection_id: String,
    path: NodePath,
) -> AppResult<Vec<TreeNode>> {
    Ok(state.sessions.introspect(&connection_id, &path).await?)
}

#[tauri::command]
pub async fn completion_snapshot(
    state: State<'_, AppState>,
    connection_id: String,
    database: String,
) -> AppResult<SchemaSnapshot> {
    Ok(state
        .sessions
        .completion_snapshot(&connection_id, &database)
        .await?)
}

/// The user's answer to a `host_key_prompt` event.
#[tauri::command]
pub fn host_key_answer(state: State<'_, AppState>, prompt_id: String, accept: bool) -> bool {
    state.host_key_prompts.answer(&prompt_id, accept)
}
